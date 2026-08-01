import postgres from "postgres";
const sql = postgres("postgres://tickets:tickets@localhost:5433/tickets", { max: 1 });
async function run() {
  await sql`delete from settings`;
  await sql.end();
}
run();
