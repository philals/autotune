import * as request from "request-promise-native";
import * as yargs from "yargs";
import * as updateNotifier from "update-notifier";

import { CreateAppKeyRequest, CreateAppKeyResponse, clientUrl, outcomesUrl } from "../common/ClientAPI";
import { User, Application } from "./Query";

import chalk from "chalk";
import { table, getBorderCharacters } from "table";

import * as moment from "moment";
import {
    tryGetUserInfo,
    setUserInfo,
    getUserInfo,
    getIDToken,
    cognito,
    clientID,
    authenticate
} from "./Authentication";
import { Outcome, Tree } from "../common/ClientConfig";

const treeify = require("treeify");

const { red, yellow, blue, magenta, cyan, dim, bold } = chalk;

async function cmdSignup(_args: yargs.Arguments, email: string, password: string): Promise<void> {
    let response;

    try {
        response = await cognito
            .signUp({
                ClientId: clientID,
                Username: email,
                Password: password,
                UserAttributes: [{ Name: "email", Value: email }]
            })
            .promise();
    } catch (e) {
        if (e.code === "UsernameExistsException") {
            console.error(`An account already exists for ${email}`);
        } else {
            console.error(`Could not sign up: ${e.message}`);
        }
        return;
    }

    if (response.UserConfirmed) {
        console.log("User creation confirmed");
    } else {
        console.log(`Confirmation code sent to ${response.CodeDeliveryDetails!.Destination}`);
        console.log('Please use the "confirm" command with the code');
    }
    await setUserInfo({ username: email, password });
}

async function createDemoApp() {
    const appKey = await createApp("My sample autotune app");
    console.log("");
    console.log("We've created a sample app for you to start with! Add this script tag:");
    console.log("");
    console.log(`  <script src="${clientUrl(appKey)}"></script>`);
    console.log("");
    console.log("Then create an experiment:");
    console.log("");
    console.log(`  <autotune>`);
    console.log(`    <h1>The glass is half full</h1>`);
    console.log(`    <h1>The glass is half empty</h1>`);
    console.log(`  <autotune>`);
    console.log("");
    console.log("Finally, add the autotune attribute to links that you want users to click:");
    console.log("");
    console.log(`  <a href="/buy" autotune>Buy now</a>`);
    console.log("");
}

async function cmdConfirm(_args: yargs.Arguments, email: string | undefined, code: string): Promise<void> {
    let password: string | undefined = undefined;
    if (email === undefined) {
        const userInfo = await getUserInfo();
        email = userInfo.username;
        password = userInfo.password;
    }
    await cognito
        .confirmSignUp({
            ClientId: clientID,
            Username: email,
            ConfirmationCode: code
        })
        .promise();
    console.log("User creation confirmed");
    if (password !== undefined) {
        await authenticateWithPassword(email, password);
        await createDemoApp();
    } else {
        console.log("Please login to start using autotune");
    }
}

async function authenticateWithPassword(email: string, password: string): Promise<void> {
    await authenticate(email, "USER_PASSWORD_AUTH", {
        USERNAME: email,
        PASSWORD: password
    });
}

async function cmdLogin(_args: yargs.Arguments, email: string, password: string): Promise<void> {
    await authenticateWithPassword(email, password);
    console.log("You're now logged in.");
}

async function makeAuthHeaders(): Promise<{ [name: string]: string }> {
    return {
        "Cache-Control": "no-cache",
        "Content-Type": "application/json",
        Authorization: await getIDToken()
    };
}

async function requestWithAuth<T>(endpoint: string, body: T): Promise<any> {
    let url: string;
    if (endpoint.startsWith("https://")) {
        url = endpoint;
    } else {
        url = "https://2vyiuehl9j.execute-api.us-east-2.amazonaws.com/prod/" + endpoint;
    }
    const requestOptions = {
        method: "POST",
        url,
        headers: await makeAuthHeaders(),
        body,
        json: true
    };
    return await request(requestOptions).promise();
}

async function createApp(name: string): Promise<string> {
    const body: CreateAppKeyRequest = { name };
    const result: CreateAppKeyResponse = await requestWithAuth("createAppKey", body);
    return result.appKey;
}

async function cmdCreateApp(_args: yargs.Arguments, name: string): Promise<void> {
    const appKey = await createApp(name);
    console.log(`✓ Created app '${magenta(name)}' with key ${bold(appKey)}`);
    console.log();
    console.log("Add this code to your web page:");
    console.log();

    console.log(
        [blue("<script"), " ", yellow("src"), blue("="), red(`"${clientUrl(appKey)}"`), blue("></script>")].join("")
    );
}

const graphQLQueryAll =
    "query {\n    viewer {\n        username\n        applications {\n            name\n            key\n            experiments {\n                name\n                started\n                options {\n                    name\n                    completed\n                    payoff\n                }\n            }\n        }\n    }\n}";
const graphQLQueryApplication =
    "query($key: String!) {\n    getApplication(key: $key) {\n        name\n        key\n        experiments {\n            name\n            started\n            options {\n                name\n                completed\n                payoff\n            }\n        }\n    }\n}";

async function queryGraphQL<T>(
    query: string,
    queryName: string,
    variables?: { [name: string]: any } | undefined
): Promise<T> {
    const body = { query, variables };
    const result = await requestWithAuth(
        "https://wnzihyd3zndg3i3zdo6ijwslze.appsync-api.us-west-2.amazonaws.com/graphql",
        body
    );
    if (result.errors !== undefined) {
        throw new Error(`Errors from server: ${JSON.stringify(result)}`);
    }
    if (result.data === null) {
        throw new Error(`No data returned from server`);
    }
    return result.data[queryName] as T;
}

async function getApp(keyOrName: string): Promise<Application | undefined> {
    const isUUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(keyOrName);

    if (isUUID) {
        const app = await queryGraphQL<Application | null>(graphQLQueryApplication, "getApplication", {
            key: keyOrName
        });
        if (app !== null) return app;
    }

    // If the it's a UUID it could still be a name - the user might use
    // UUIDs as app names.
    const user = await queryGraphQL<User>(graphQLQueryAll, "viewer");
    return user.applications.find(a => a.name === keyOrName);
}

async function listApps(_args: yargs.Arguments): Promise<void> {
    const user = await queryGraphQL<User>(graphQLQueryAll, "viewer");
    const apps = user.applications
        .sort((a, b) => a.name.localeCompare(b.name))
        .map(app => [magenta(app.name), app.key]);
    logTable([[bold("App Name"), bold("Key")], ...apps]);
}

async function cmdListExperiments(_args: yargs.Arguments, appKey: string): Promise<void> {
    const app = await getApp(appKey);
    if (app === undefined) {
        throw new Error("Application not found");
    }
    for (const experiment of app.experiments) {
        const rows: any[] = [];

        const ago = moment(experiment.started).fromNow();
        rows.push([bold(magenta(experiment.name)), `Since ${ago}`, "Conversion"]);

        const options = experiment.options
            .map(o => ({
                ...o,
                result: o.payoff / o.completed
            }))
            .sort((a, b) => b.result - a.result);

        let first = true;
        for (const o of options) {
            const conversionRate = (Math.floor(o.result * 1000) / 10).toString();
            const conversion = first ? bold(conversionRate) : conversionRate;
            const star = yellow("★");
            const name = first ? bold(o.name + " " + star) : o.name;
            rows.push([name, dim(`${o.completed} instances`), `${conversion}%`]);
            first = false;
        }

        logTable(rows);
    }
}

type PrintTree = string | { [name: string]: PrintTree };

function makePrintTree(outcome: Outcome): PrintTree {
    const options = outcome.options;

    function convert(t: Tree): any {
        if (t.best !== undefined) {
            return `${bold(options[t.best])} - epsilon: ${t.eps}`;
        }
        const { op, neg } = t.op === "lt" ? { op: "<", neg: ">=" } : { op: "=", neg: "!=" };
        const result: PrintTree = {};
        result[`${t.at} ${op} ${t.v}`] = convert(t.l!);
        result[`${t.at} ${neg} ${t.v}`] = convert(t.r!);
        return result;
    }

    return convert(outcome.tree);
}

async function cmdShowTrees(appKey: string): Promise<void> {
    const app = await getApp(appKey);
    if (app === undefined) {
        throw new Error("Application not found");
    }
    const requestOptions = {
        method: "GET",
        url: outcomesUrl(app.key),
        json: true
    };
    const outcomes: { [key: string]: Outcome } = await request(requestOptions).promise();
    for (const experimentKey of Object.getOwnPropertyNames(outcomes)) {
        console.log(bold(magenta(experimentKey)));
        console.log(treeify.asTree(makePrintTree(outcomes[experimentKey]), true));
    }
}

async function graphQL(_args: yargs.Arguments): Promise<void> {
    console.log(JSON.stringify(await queryGraphQL<User>(graphQLQueryAll, "viewer"), undefined, 4));
}

function notifyIfCLIUpdatesAvailable() {
    try {
        const pkg = require("../../package.json");
        const notifier = updateNotifier({ pkg });
        notifier.notify();
    } catch (e) {}
}

async function main(): Promise<void> {
    let didSomething = false;

    function cmd(p: Promise<void>): void {
        p.catch(e => {
            console.error(e);
            process.exit(1);
        });
        didSomething = true;
    }

    const argv = yargs
        .usage(`Usage: ${cyan("$0")} <command> ${dim("[options]")}`)
        .command(
            "signup <email> <password>",
            dim("Create a new account"),
            ya => ya.positional("email", { type: "string" }).positional("password", { type: "string" }),
            args => cmd(cmdSignup(args, args.email, args.password))
        )
        .command(
            "confirm <code>",
            dim("Confirm a new account"),
            ya => ya.positional("email", { type: "string" }).positional("code", { type: "string" }),
            args => cmd(cmdConfirm(args, args.email, args.code))
        )
        .command(
            "login <email> <password>",
            dim("Login"),
            ya => ya.positional("email", { type: "string" }).positional("password", { type: "string" }),
            args => cmd(cmdLogin(args, args.email, args.password))
        )
        .command(
            "new <name>",
            dim("Create a new app"),
            ya => ya.positional("name", { type: "string" }),
            args => cmd(cmdCreateApp(args, args.name))
        )
        .command(
            "ls [key|name]",
            dim("List apps or experiments for an app"),
            ya => ya.positional("key", { type: "string" }),
            args => {
                if (args.key !== undefined) {
                    cmd(cmdListExperiments(args, args.key));
                } else {
                    cmd(listApps(args));
                }
            }
        )
        .command(
            "trees <key|name>",
            dim("Show decision trees for experiments in an app"),
            ya => ya.positional("key", { type: "string" }),
            args => cmd(cmdShowTrees(args.key))
        )
        .command("graphql", false, {}, args => cmd(graphQL(args)))
        .wrap(yargs.terminalWidth()).argv;

    if (!didSomething || argv.help) {
        if ((await tryGetUserInfo()) === undefined) {
            console.error("You're not logged in to autotune.");
            console.error("");
            console.error("  Create account: tune signup EMAIL PASSWORD");
            console.error("  Log in:         tune login EMAIL PASSWORD");
            console.error("");
        }
        yargs.showHelp();
    }
    notifyIfCLIUpdatesAvailable();
}

function removeWhitespace(data: any): any {
    if (Array.isArray(data)) {
        return data.map(removeWhitespace);
    }
    if (typeof data === "string") {
        return data.replace(/\s+/g, " ").trim();
    }
    return data;
}

function logTable(rows: any[], style: "void" | "norc" = "norc") {
    rows = removeWhitespace(rows);
    console.log(
        table(rows, {
            border: getBorderCharacters(style)
        })
    );
}

main().catch(e => console.error(e));
