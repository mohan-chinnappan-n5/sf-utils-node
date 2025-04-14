// lib/utils.js
async function getUserIdFromUsername(conn, username) {
    const result = await conn.query(`SELECT Id FROM User WHERE Username = '${username}' LIMIT 1`);
    if (result.records.length === 0) {
        throw new Error(`User with username "${username}" not found.`);
    }
    return result.records[0].Id;
}

function generatePackageXml(records) {
    const typesMap = new Map();
    records.forEach(record => {
        if (!typesMap.has(record.MemberType)) {
            typesMap.set(record.MemberType, []);
        }
        typesMap.get(record.MemberType).push(record.MemberName);
    });

    let xml = '<?xml version="1.0" encoding="UTF-8"?>\n';
    xml += '<Package xmlns="http://soap.sforce.com/2006/04/metadata">\n';
    for (const [type, members] of typesMap) {
        xml += '    <types>\n';
        members.forEach(member => {
            xml += `        <members>${member}</members>\n`;
        });
        xml += `        <name>${type}</name>\n`;
        xml += '    </types>\n';
    }
    xml += '    <version>59.0</version>\n';
    xml += '</Package>';
    return xml;
}

module.exports = {
    getUserIdFromUsername,
    generatePackageXml
};