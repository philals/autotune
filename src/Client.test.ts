import { Client, Outcomes, apiURL } from "./Client";
import { Environment } from "./Environment";
import { Tree, Op } from "./common/ClientConfig";
import { Convert } from "./common/models";

import * as validateUUID from "uuid-validate";

const appKey = "abcde";
const experimentName = "ex";
const clientContext = { tzo: -420, lang: "en" };

function failAndThrow(msg: string): never {
    fail(msg);
    throw new Error(msg);
}

// If this is not a function, tslint complains that we have
// an unused value.
function makeClient(env: Environment, then: (c: Client) => void): Client {
    return new Client(env, appKey, then);
}

function testAsync(name: string, fn: (resolve: () => void) => void): void {
    test(name, async () => {
        return new Promise((resolve, reject) => {
            try {
                fn(resolve);
            } catch (e) {
                reject(e);
            }
        });
    });
}

function after(ms: number, fn: () => void): void {
    setTimeout(fn, ms);
}

class TestEnvironment implements Environment {
    static test(name: string, outcomes: Outcomes | undefined, fn: (env: TestEnvironment) => void): void {
        function test(suffix: string, makeEnv: (name: string, resolve: () => void) => TestEnvironment) {
            const fullName = name + suffix;
            testAsync(fullName, resolve => {
                const env = makeEnv(fullName, resolve);
                makeClient(env, client => {
                    env.setClient(client);
                    after(150, () => fn(env));
                });
            });
        }

        for (const allowStartExperiments of [false, true]) {
            for (const allowSetLocalStorage of [false, true]) {
                for (const allowCompleteExperiments of [false, true]) {
                    const withs: string[] = [];
                    if (allowStartExperiments) withs.push("startExperiments");
                    if (allowSetLocalStorage) withs.push("local storage");
                    if (allowCompleteExperiments) withs.push("completeExperiments");
                    const suffix = withs.length === 0 ? "" : ` with ${withs.join(",")}`;
                    test(
                        suffix,
                        (n, resolve) =>
                            new TestEnvironment(
                                n,
                                outcomes,
                                allowStartExperiments,
                                allowSetLocalStorage,
                                allowCompleteExperiments,
                                resolve
                            )
                    );
                }
            }
        }
    }

    private maybeClient: Client | undefined;

    readonly logs: any[][] = [];
    readonly errors: any[][] = [];

    numOutcomesRequested: number = 0;
    htmlExperimentsStarted: boolean = false;
    startExperimentsData: any = undefined;
    completeExperimentsData: any = undefined;
    readonly localStorage: { [key: string]: string } = {};

    constructor(
        private readonly name: string,
        private readonly outcomes: Outcomes | undefined,
        readonly allowStartExperiments: boolean,
        readonly allowSetLocalStorage: boolean,
        readonly allowCompleteExperiments: boolean,
        readonly resolve: () => void
    ) {}

    setClient(client: Client): void {
        if (this.maybeClient !== undefined) {
            return failAndThrow("Client cannot be set twice");
        }
        this.maybeClient = client;
    }

    getClient(): Client {
        if (this.maybeClient === undefined) {
            return failAndThrow("Client not set");
        }
        return this.maybeClient;
    }

    getOptions(): string[] {
        if (this.outcomes === undefined) {
            return failAndThrow("No options when no outcomes are defined");
        }
        const outcomes = this.outcomes[experimentName];
        if (outcomes === undefined) {
            return failAndThrow("Experiment not defined");
        }
        return outcomes.options;
    }

    log(...args: any[]): void {
        console.log(this.name, ...args);
        this.logs.push(args);
    }

    error(...args: any[]): void {
        console.error(this.name, ...args);
        this.errors.push(args);
    }

    getTimeZoneOffset(): number {
        return clientContext.tzo;
    }

    getLocalLanguage(): string | undefined {
        return clientContext.lang;
    }

    http(
        method: "POST" | "GET",
        url: string,
        data: any,
        resolve: (data: any) => void,
        reject: (err: Error) => void
    ): void {
        setTimeout(() => {
            if (method === "GET" && url.endsWith(`${appKey}.tree.json`)) {
                this.numOutcomesRequested += 1;
                if (this.outcomes === undefined) {
                    reject(new Error("Simulated GET outcomes failure"));
                } else {
                    console.log("returning HTTP");
                    resolve(this.outcomes);
                }
            } else if (method === "POST" && url === apiURL("startExperiments")) {
                if (data === undefined) {
                    return failAndThrow("No data given for startExperiments");
                }
                if (this.startExperimentsData !== undefined) {
                    return failAndThrow("startExperiments posted more than once");
                }
                this.startExperimentsData = data;
                if (this.allowStartExperiments) {
                    resolve({});
                } else {
                    reject(new Error("Simulated POST startExperiments failure"));
                }
            } else if (method === "POST" && url === apiURL("completeExperiments")) {
                if (data === undefined) {
                    return failAndThrow("No data given for completeExperiments");
                }
                if (this.completeExperimentsData !== undefined) {
                    return failAndThrow("completeExperiments posted more than once");
                }
                this.completeExperimentsData = data;
                if (this.allowCompleteExperiments) {
                    resolve({});
                } else {
                    reject(new Error("Simulated POST completeExperiments failure"));
                }
            } else {
                fail(`Unexpected HTTP request: ${method} to ${url}`);
            }
        }, 10);
    }

    getLocalStorage(key: string): string | undefined {
        throw new Error("Method not implemented.");
    }

    setLocalStorage(key: string, value: string): void {
        if (this.allowSetLocalStorage) {
            this.localStorage[key] = value;
        } else {
            throw new Error("Local storage simulated not to work");
        }
    }

    startHTMLExperiments(): void {
        this.htmlExperimentsStarted = true;
    }
}

function makeOptions(n: number): string[] {
    const options: string[] = [];
    for (let i = 0; i < n; i++) {
        options.push(`o${i.toString()}`);
    }
    return options;
}

function makeOutcomes(n: number, tree: Tree): Outcomes {
    const options = makeOptions(n);
    const outcomes: Outcomes = {};
    outcomes[experimentName] = { options, tree };
    return outcomes;
}

function leaf(best: number): Tree {
    return { best, eps: 0 };
}

function tzoLt(v: number, l: Tree, r: Tree): Tree {
    return { at: "tzo", op: Op.Lt, v, l, r };
}

function langEq(v: string, l: Tree, r: Tree): Tree {
    return { at: "lang", op: Op.Eq, v, l, r };
}

function checkInit(env: TestEnvironment): void {
    expect(env.numOutcomesRequested).toBe(1);
    expect(env.htmlExperimentsStarted).toBe(true);
}

function checkState(localStorage: { [key: string]: string }, pick: string | undefined): void {
    const str = localStorage[`autotune.v1.${appKey}.state`];
    if (str === undefined) {
        return failAndThrow("Local storage state not set");
    }
    const state = Convert.toSerializedState(str);
    const now = new Date().getTime();
    expect(state.lastInitialized).toBeLessThanOrEqual(now);
    expect(state.lastInitialized).toBeGreaterThan(now - 1100);
    const keys = Object.getOwnPropertyNames(state.experimentPicks);
    if (pick === undefined) {
        expect(keys).toEqual([]);
    } else {
        expect(keys).toEqual([experimentName]);
        expect(state.experimentPicks[experimentName]).toBe(pick);
    }
}

function checkStartExperiments(data: any, options: string[], pick: string, pickedBest: boolean | undefined): string {
    if (typeof data !== "object" || data === null) {
        return failAndThrow("Illegal startExperiments data");
    }

    expect(data.version).toBe(2);
    expect(data.appKey).toBe(appKey);
    expect(data.ctx).toEqual(clientContext);

    expect(Object.getOwnPropertyNames(data.experiments)).toEqual([experimentName]);
    const ex = data.experiments[experimentName];
    if (!validateUUID(ex.instanceKey, 4)) {
        fail("instanceKey is not a v4 UUID");
    }
    expect(ex.options).toEqual(options);
    expect(ex.pick).toBe(pick);
    if (pickedBest !== undefined) {
        expect(ex.pickedBest).toBe(pickedBest);
    }

    return ex.instanceKey;
}

function checkCompleteExperiments(data: any, instanceKey: string, pick: string, payoff: number): void {
    if (typeof data !== "object" || data === null) {
        return failAndThrow("Illegal completeExperiments data");
    }

    expect(data.appKey).toBe(appKey);

    const experiments: { [name: string]: any } = {};
    experiments[instanceKey] = { pick, payoff };
    expect(data.experiments).toEqual(experiments);
}

TestEnvironment.test("can init when network fails", undefined, env => {
    checkInit(env);
    after(200, () => {
        expect(env.errors.length).toBeGreaterThan(0);
        expect(env.startExperimentsData).toBe(undefined);
        env.resolve();
    });
});

TestEnvironment.test("can init with network", {}, env => {
    checkInit(env);
    after(200, () => {
        if (env.allowSetLocalStorage) {
            expect(env.errors.length).toBe(0);
            checkState(env.localStorage, undefined);
        }
        expect(env.startExperimentsData).toBe(undefined);
        env.resolve();
    });
});

TestEnvironment.test("can run experiment when network fails", undefined, env => {
    checkInit(env);
    const options = makeOptions(2);
    const ex = env.getClient().experiment(experimentName, options);
    expect(ex.pick).toMatch(/^o[01]$/);
    after(200, () => {
        if (env.allowSetLocalStorage) {
            checkState(env.localStorage, ex.pick);
        }
        checkStartExperiments(env.startExperimentsData, options, ex.pick, undefined);
        env.resolve();
    });
});

TestEnvironment.test("single node", makeOutcomes(2, leaf(1)), env => {
    checkInit(env);
    const ex = env.getClient().experiment(experimentName, env.getOptions());
    expect(ex.pick).toBe("o1");
    after(200, () => {
        if (env.allowSetLocalStorage) {
            checkState(env.localStorage, "o1");
        }
        checkStartExperiments(env.startExperimentsData, env.getOptions(), "o1", true);
        env.resolve();
    });
});

function testTree(name: string, outcomes: Outcomes, pick: string): void {
    for (const complete of [false, true]) {
        TestEnvironment.test(name + (complete ? " with completion" : ""), outcomes, env => {
            checkInit(env);
            const ex = env.getClient().experiment(experimentName, env.getOptions());
            expect(ex.pick).toBe(pick);
            after(200, () => {
                if (env.allowSetLocalStorage) {
                    checkState(env.localStorage, pick);
                }
                const instanceKey = checkStartExperiments(env.startExperimentsData, env.getOptions(), pick, true);
                if (complete) {
                    env.getClient().completeDefaults(0.123, () => {
                        checkCompleteExperiments(env.completeExperimentsData, instanceKey, pick, 0.123);
                        env.resolve();
                    });
                } else {
                    env.resolve();
                }
            });
        });
    }
}

testTree("branch on tzo left", makeOutcomes(3, tzoLt(-410, leaf(1), leaf(2))), "o1");
testTree("branch on tzo right", makeOutcomes(3, tzoLt(-430, leaf(1), leaf(2))), "o2");

testTree("branch on lang left", makeOutcomes(3, langEq("en", leaf(1), leaf(2))), "o1");
testTree("branch on lang right", makeOutcomes(3, langEq("de", leaf(1), leaf(2))), "o2");

// Missing tests:

// undefined language works

// Multiple experiments work

// Not making unnecessary network calls - wait 1s or so

// Picks in local storage are honored if they're young

// Picks in local storage are ignored if they're old