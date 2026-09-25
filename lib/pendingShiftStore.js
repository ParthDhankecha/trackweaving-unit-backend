const fs = require("fs").promises;
const path = require("path");
const crypto = require("crypto");

const queueDir =
    process.env.SHIFT_QUEUE_DIR ||
    (typeof process.pkg !== "undefined"
        ? path.dirname(process.execPath)
        : path.join(__dirname, ".."));
const QUEUE_FILE = path.join(queueDir, "pending-shift-logs.json");

let entries = [];
let loaded = false;
let writeChain = Promise.resolve();

async function load() {
    if (loaded) {
        return entries;
    }
    try {
        const raw = await fs.readFile(QUEUE_FILE, "utf8");
        const parsed = JSON.parse(raw);
        entries = Array.isArray(parsed) ? parsed : [];
    } catch (err) {
        if (err.code !== "ENOENT") {
            console.warn("Could not read pending shift queue:", err.message);
        }
        entries = [];
    }
    loaded = true;
    return entries;
}

function persist() {
    writeChain = writeChain.then(async () => {
        const tmp = `${QUEUE_FILE}.${process.pid}.tmp`;
        await fs.writeFile(tmp, JSON.stringify(entries, null, 0), "utf8");
        await fs.rename(tmp, QUEUE_FILE);
    }).catch((err) => {
        console.error("Failed to persist pending shift queue:", err.message);
    });
    return writeChain;
}

function makeEntryId(machineId, snapshot) {
    const key = [
        machineId,
        snapshot.shift,
        snapshot.updatedTime || "",
        snapshot.closedAt || ""
    ].join("|");
    return crypto.createHash("sha256").update(key).digest("hex").slice(0, 24);
}

/**
 * @param {string} machineId
 * @param {object} snapshot Closed-shift machine state (before counters reset)
 */
async function enqueueClosedShift(machineId, snapshot) {
    if (!snapshot || typeof snapshot.shift !== "number") {
        return null;
    }

    await load();

    const closedAt = new Date().toISOString();
    const payload = {
        machineId: String(machineId),
        displayType: snapshot.displayType,
        shift: snapshot.shift,
        stopsData: snapshot.stopsData,
        stopCount: snapshot.stopCount,
        rawData: snapshot.rawData,
        updatedTime: snapshot.updatedTime || closedAt,
        lastStartTime: snapshot.lastStartTime ?? null,
        lastStopTime: snapshot.lastStopTime ?? null
    };

    const id = makeEntryId(machineId, { ...snapshot, closedAt });
    if (entries.some((e) => e.id === id)) {
        return id;
    }

    entries.push({ id, closedAt, payload });
    await persist();
    console.log(
        new Date(),
        `Queued closed shift for machine ${machineId} (shift ${snapshot.shift}), pending=${entries.length}`
    );
    return id;
}

async function listPending() {
    await load();
    return entries.slice();
}

async function removeByIds(ids) {
    if (!ids.length) {
        return;
    }
    await load();
    const drop = new Set(ids);
    const before = entries.length;
    entries = entries.filter((e) => !drop.has(e.id));
    if (entries.length !== before) {
        await persist();
    }
}

async function pendingCountByMachine() {
    await load();
    const counts = {};
    for (const entry of entries) {
        const mid = entry.payload?.machineId;
        if (mid) {
            counts[mid] = (counts[mid] || 0) + 1;
        }
    }
    return counts;
}

module.exports = {
    load,
    enqueueClosedShift,
    listPending,
    removeByIds,
    pendingCountByMachine,
    QUEUE_FILE
};
