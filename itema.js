"use strict";

const net = require("net");

const DEFAULT_PORT = 12555;
const SOCKET_TIMEOUT = 4000;


/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

const readU16 = (buf, offset) =>
    offset + 2 <= buf.length ? buf.readUInt16LE(offset) : 0;

const readU32 = (buf, offset) =>
    offset + 4 <= buf.length ? buf.readUInt32LE(offset) : 0;

function sumU32(buf, start, end) {
    let total = 0;

    for (let offset = start; offset <= end; offset += 4) {
        total += readU32(buf, offset);
    }

    return total;
}


/* -------------------------------------------------------------------------- */
/* Itema Request                                                              */
/* -------------------------------------------------------------------------- */

function buildPacket(idt) {
    const packet = Buffer.alloc(11);

    packet[0] = 0xff;
    packet.writeUInt32LE(0, 1);
    packet[5] = idt;
    packet.writeUInt32LE(1, 6);
    packet[10] = 0x02;

    return packet;
}

function request(ip, port, idt) {
    return new Promise((resolve, reject) => {
        const socket = net.createConnection({ host: ip, port });
        const chunks = [];
        let finished = false;

        const fail = error => {
            if (finished) return;

            finished = true;
            socket.destroy();
            reject(error);
        };

        socket.on("connect", () => {
            socket.write(buildPacket(idt));
        });

        socket.on("data", chunk => {
            chunks.push(chunk);
        });

        socket.on("error", fail);

        socket.on("end", () => {
            if (finished) return;
            finished = true;

            try {
                const response = Buffer.concat(chunks);

                if (response.length < 10) {
                    throw new Error(`IDT ${idt}: response too short`);
                }

                if (response[0] !== 0xff) {
                    throw new Error(`IDT ${idt}: invalid header`);
                }

                const responseIdt = response[5];
                const dataLength = response.readUInt32LE(6);

                if (responseIdt !== idt) {
                    throw new Error(
                        `IDT ${idt}: unexpected response IDT ${responseIdt}`
                    );
                }

                if (response.length < 10 + dataLength) {
                    throw new Error(`IDT ${idt}: incomplete response`);
                }

                resolve(response.subarray(10, 10 + dataLength));
            } catch (error) {
                reject(error);
            }
        });

        socket.setTimeout(SOCKET_TIMEOUT, () => {
            fail(new Error(`IDT ${idt}: timeout`));
        });
    });
}


/* -------------------------------------------------------------------------- */
/* IDT 5 - Current Stop                                                       */
/* -------------------------------------------------------------------------- */

function parseLive(buf) {
    return {
        stopCategory: buf[2] ?? 0,
        stopDetail: buf[3] ?? 0
    };
}


/* -------------------------------------------------------------------------- */
/* IDT 18 - Speed + Weft Density                                              */
/* -------------------------------------------------------------------------- */

function parsePrincipal(buf) {
    const densityRaw = readU16(buf, 47);

    return {
        speed: readU16(buf, 45),
        weftDensity: Number(((densityRaw / 10) * 2.54).toFixed(2))
    };
}


/* -------------------------------------------------------------------------- */
/* IDT 200 - Current Shift                                                    */
/* -------------------------------------------------------------------------- */

function parseShift(buf) {
    const shiftCode = buf[1] ? String.fromCharCode(buf[1]) : null;

    const shiftMap = {
        A: 0, // Day
        B: 1  // Night
    };

    const currentShiftId = shiftCode !== null
        ? shiftMap[shiftCode] ?? null
        : null;
    const picksCurrentShift = readU32(buf, 14);

    // Stop counts
    const weftCount =
        sumU32(buf, 18, 78) +
        sumU32(buf, 82, 142) +
        sumU32(buf, 146, 206) +
        sumU32(buf, 210, 270) +
        sumU32(buf, 274, 334);

    const warpCount =
        readU32(buf, 338) +
        readU32(buf, 342) +
        readU32(buf, 346) +
        readU32(buf, 350);

    const otherCount =
        readU32(buf, 354) +
        readU32(buf, 358) +
        readU32(buf, 362) +
        readU32(buf, 366) +
        readU32(buf, 370) +
        readU32(buf, 378);

    const manualCount = readU32(buf, 374);
    const feederCount = readU32(buf, 382);


    // Stop durations
    const weftDuration =
        readU32(buf, 386) +
        readU32(buf, 390) +
        readU32(buf, 394) +
        readU32(buf, 398) +
        readU32(buf, 402);

    const warpDuration =
        readU32(buf, 406) +
        readU32(buf, 410) +
        readU32(buf, 414) +
        readU32(buf, 418);

    const otherDuration =
        readU32(buf, 422) +
        readU32(buf, 426) +
        readU32(buf, 430) +
        readU32(buf, 434) +
        readU32(buf, 438) +
        readU32(buf, 446);

    const manualDuration = readU32(buf, 442);
    const feederDuration = readU32(buf, 450);


    // Production
    const totalShiftTime = readU32(buf, 454);
    const productionMtr = readU32(buf, 458) / 100;

    const downtime =
        warpDuration +
        weftDuration +
        feederDuration +
        manualDuration +
        otherDuration;

    const runtime = Math.max(0, totalShiftTime - downtime);

    const efficiency = totalShiftTime > 0
        ? (runtime / totalShiftTime) * 100
        : 0;

    return {
        currentShiftId,
        efficiency: Number(efficiency.toFixed(2)),
        picksCurrentShift,
        productionMtr: Number(productionMtr.toFixed(2)),
        runtime,

        warp: {
            count: warpCount,
            duration: warpDuration
        },

        weft: {
            count: weftCount,
            duration: weftDuration
        },

        feeder: {
            count: feederCount,
            duration: feederDuration
        },

        manual: {
            count: manualCount,
            duration: manualDuration
        },

        other: {
            count: otherCount,
            duration: otherDuration
        }
    };
}


/* -------------------------------------------------------------------------- */
/* Read Machine                                                               */
/* -------------------------------------------------------------------------- */

async function readItemaMachine(ip, port = DEFAULT_PORT) {
    const liveBuf = await request(ip, port, 5);
    const principalBuf = await request(ip, port, 18);
    const shiftBuf = await request(ip, port, 200);

    const live = parseLive(liveBuf);
    const principal = parsePrincipal(principalBuf);
    const shift = parseShift(shiftBuf);

    return {
        currentShiftId: shift.currentShiftId,
        speed: principal.speed,
        efficiency: shift.efficiency,
        picksCurrentShift: shift.picksCurrentShift,
        productionMtr: shift.productionMtr,
        runtime: shift.runtime,
        weftDensity: principal.weftDensity,

        stopCategory: live.stopCategory,
        stopDetail: live.stopDetail,

        warp: shift.warp,
        weft: shift.weft,
        feeder: shift.feeder,
        manual: shift.manual,
        other: shift.other
    };
}

module.exports = {
    DEFAULT_PORT,
    readItemaMachine
};
