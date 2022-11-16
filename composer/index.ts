import sqlite3 from "sqlite3";
import { open } from "sqlite";
import { promisify } from "util";
import toml from "@iarna/toml";

const execFile = promisify(require("node:child_process").execFile);
const writeFile = promisify(require("node:fs").writeFile);

const dbName = "combinations.db";

class Instance {
    count: number;

    constructor(count: number) {
        this.count = count;
    }
}

class Group {
    id: string;
    transport: string;
    muxer: string;
    instance: Instance;

    constructor(id: string, transport: string, muxer: string, instance: Instance) {
        this.id = id;
        this.transport = transport;
        this.muxer = muxer;
        this.instance = instance;
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
  await db.close()

  let output = new Composition([]);

  for (let row of queryResults) {
      let instance = new Instance(1);

      let group1 = new Group(row.id1, row.transport, row.muxer, instance)
      let group2 = new Group(row.id2, row.transport, row.muxer, instance)

      let run = new Run(`${row.id1} x ${row.id2}`, [group1, group2]);

      output.runs.push(run);
  }

  await writeFile("composition.toml", toml.stringify(output as any));
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });

