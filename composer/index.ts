import sqlite3 from "sqlite3";
import { open } from "sqlite";
import { promisify } from "util";
import toml from "@iarna/toml";
import yargs from "yargs";

const execFile = promisify(require("node:child_process").execFile);
const writeFile = promisify(require("node:fs").writeFile);
const unlink = promisify(require("node:fs").unlink);

const DB = "combinations.db";
// Set the builder as docker generic for every group.
const BUILDER = "docker:generic";

// Command line arguments.
const argv = yargs(process.argv.slice(2)).options({
    "git-rev": { type: "string", demandOption: true },
    "git-target": { type: "string", demandOption: true },
    "total_instances": { type: "number", demandOption: true },
}).parseSync();

// TOML schema to generate.
class Instance {
    count: number;

    constructor(count: number) {
        this.count = count;
    }
}

class BuildArgs {
    TRANSPORT: string;
    MUXER: string;
    VERSION: string;

    constructor(transport: string, muxer: string, version: string) {
        this.TRANSPORT = transport;
        this.MUXER = muxer;
        this.VERSION = version
    }
}
class BuildConfig {
    build_args: BuildArgs;

    constructor(build_args: BuildArgs) {
        this.build_args = build_args;
    }
}
class Group {
    id: string;
    builder: string;
    build_config: BuildConfig;
    instances: Instance;

    constructor(
        id: string,
        builder: string,
        instances: Instance,
        build_config: BuildConfig,
    ) {
        this.id = id;
        this.builder = builder;
        this.instances = instances;
        this.build_config = build_config;
    }
}

class Run {
    id: string;
    groups: Group[];

    constructor(id: string, groups: Group[]) {
        this.id = id;
        this.groups = groups;
    }
}

class Global {
    plan: string;
    case: string;
    total_instances: number;

    constructor(plan: string, plan_case: string, total_instances: number) {
        this.plan = plan;
        this.case = plan_case;
        this.total_instances = total_instances;
    }
}

class Composition {
    global: Global;
    runs: Run[];

    constructor(global: Global, runs: Run[]) {
        this.global = global;
        this.runs = runs;
    }
}

async function main() {
    sqlite3.verbose();

    // Call sqlite to process the csv resource files and generate a database.
    // We call the sqlite process instead of doing it here cause
    // the dot commands are interpreted by the sqlite cli tool not sqlite itself,
    // and it is a lot faster parsing the csv's.
    const { stdout, stderr } = await execFile("sqlite3", [
        DB,
        ".mode csv",
        ".import transports.csv transports",
        ".import muxers.csv muxers",
    ]);
    if (stderr != "") {
        throw new Error(`Could not parse csv resources: ${stderr}`);
    }

    const db = await open({
        filename: DB,
        driver: sqlite3.Database,
    });

    // Generate the testing combinations by SELECT'ing from both transports
    // and muxers tables the distinct combinations where the transport and the muxer
    // of the different libp2p implementations match.
    const queryResults =
        await db.all(`SELECT DISTINCT a.id as id1, b.id as id2, a.transport, ma.muxer
                     FROM transports a, transports b, muxers ma, muxers mb
                     WHERE a.id != b.id
                     AND a.transport == b.transport
                     AND a.id == ma.id
                     AND b.id == mb.id
                     AND ma.muxer == mb.muxer;`);
    await db.close();

    let global = new Global("multidimensional-testing", "multidimensional", argv.total_instances);
    let composition = new Composition(global, []);

    for (let row of queryResults) {
        // Instance count is hardcoded to 1 for now.
        let instance = new Instance(1);

        let build_args1 = new BuildArgs(row.transport, row.muxer, row.id1);
        let build_config1 = new BuildConfig(build_args1);
        let group1 = new Group(row.id1, BUILDER, instance, build_config1);

        let build_args2 = new BuildArgs(row.transport, row.muxer, row.id2);
        let build_config2 = new BuildConfig(build_args2);
        let group2 = new Group(row.id2, BUILDER, instance, build_config2);

        let run = new Run(`${row.id1} x ${row.id2} x ${row.transport} x
                          ${row.muxer}`, [group1, group2]);

        composition.runs.push(run);
    }

    // Write the TOML file and remove the database file to avoid corrupting
    // future runs.
    await writeFile("composition.toml", toml.stringify(composition as any));
    await unlink(DB);
}

main()
    .then(() => process.exit(0))
    .catch((err) => {
        console.error(err);
        process.exit(1);
    });

