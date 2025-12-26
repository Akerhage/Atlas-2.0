const fs = require('fs');
const db = require('./db');

try {
  const rawData = fs.readFileSync('./templates.json', 'utf8');
  const templates = JSON.parse(rawData);

  db.serialize(() => {
    const stmt = db.prepare("INSERT INTO templates (title, content, group_name) VALUES (?, ?, ?)");

    templates.forEach((template) => {
      // Mappar JSON-fält till DB-kolumner enligt instruktion
      stmt.run(template.title, template.content, template.group);
    });

    stmt.finalize(() => {
      console.log(`Migration klar: ${templates.length} mallar flyttade till atlas.db.`);
    });
  });

} catch (err) {
  console.error("Fel vid migration:", err);
}