// lib/apex.js
async function runApex(conn, apexCode) {
    return await conn.tooling.executeAnonymous(apexCode);
}

module.exports = { runApex };