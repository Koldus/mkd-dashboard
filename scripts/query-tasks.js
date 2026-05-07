require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { Client } = require('@notionhq/client');

const notion = new Client({ auth: process.env.NOTION_API_KEY });
const DATA_SOURCE_ID = '337c6479-bfcb-80d6-87de-000b0d491abd';

async function main() {
  const filter = process.argv[2];
  const today = new Date().toISOString().slice(0, 10);

  const pages = [];
  let cursor;
  do {
    const res = await notion.dataSources.query({
      data_source_id: DATA_SOURCE_ID,
      start_cursor: cursor,
      page_size: 100,
    });
    pages.push(...res.results);
    cursor = res.has_more ? res.next_cursor : undefined;
  } while (cursor);

  const tasks = pages.map(p => ({
    id: p.id,
    name: p.properties.Name?.title?.[0]?.plain_text ?? '(unnamed)',
    status: p.properties.Status?.status?.name ?? null,
    project: p.properties.Project?.select?.name ?? null,
    last_edited: p.last_edited_time?.slice(0, 10),
    url: p.url,
  }));

  if (filter === 'active') {
    const active = tasks.filter(t => t.status === 'Today' || t.status === 'In progress');
    console.log(JSON.stringify(active, null, 2));
  } else if (filter === 'changed-today') {
    console.log(JSON.stringify(tasks.filter(t => t.last_edited === today), null, 2));
  } else {
    console.log(JSON.stringify(tasks, null, 2));
  }
}

main().catch(e => { console.error(e.message); process.exit(1); });
