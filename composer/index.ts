import sqlite3 from "sqlite3";
import { open } from "sqlite";
import { promisify } from "util";
import toml from "@iarna/toml";

const execFile = promisify(require("node:child_process").execFile);
const writeFile = promisify(require("node:fs").writeFile);
const unlink = promisify(require("node:fs").unlink);

const dbName = "combinations.db";

class Instance {
    count: number;

    constructor(count: number) {
        this.count = count;
    }
}

class Params {
    transport: string;
    muxer: string;

    constructor(transport: string, muxer: string) {
        this.transport = transport;
        this.muxer = muxer;
    }
}

class Group {
    id: string;
    test_params: Params;
    instances: Instance;

    constructor(
        id: string,
        instances: Instance,
        test_params: Params
    ) {
        this.id = id;
        this.instances = instances;
        this.test_params = test_params;
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

class Composition {
    runs: Run[];

    constructor(runs: Run[]) {
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
        dbName,
        ".mode csv",
        ".import transports.csv transports",
        ".import muxers.csv muxers",
    ]);
    if (stderr != "") {
        throw new Error(`Could not parse csv resources: ${stderr}`);
    }

    const db = await open({
        filename: dbName,
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

    let output = new Composition([]);

    for (let row of queryResults) {
        let instance = new Instance(1);

        let test_params = new Params(row.transport, row.muxer)
        let group1 = new Group(row.id1, instance, test_params);
        let group2 = new Group(row.id2, instance, test_params);

        let run = new Run(`${row.id1} x ${row.id2}`, [group1, group2]);

        output.runs.push(run);
    }

    // Write the TOML file and remove the database file to avoid corrupting
    // future runs.
    await writeFile("composition.toml", toml.stringify(output as any));
    await unlink(dbName);
}

main()
    .then(() => process.exit(0))
    .catch((err) => {
        console.error(err);
        process.exit(1);
    });

