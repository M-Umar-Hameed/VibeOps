import postgres from "postgres";
const sql = postgres("postgres://tickets:tickets@localhost:5433/tickets", { max: 1 });
async function run() {
  const res = await sql`select * from settings where key='forge.defaultModel.plan'`;
  console.log("rows:", res.length);
  if (res.length > 0) console.log(res[0]);
  await sql.end();
}
run();
