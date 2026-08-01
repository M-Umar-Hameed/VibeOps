import postgres from "postgres";
const sql = postgres("postgres://tickets:tickets@localhost:5433/tickets", { max: 1 });
async function run() {
  await sql`insert into settings(key,value) values('forge.defaultModel.plan','fake:smart') on conflict(key) do update set value='fake:smart'`;
  await sql.end();
}
run();
