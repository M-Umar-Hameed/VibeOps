import postgres from 'postgres';
(async()=>{
  const s = postgres('postgres://tickets:tickets@localhost:5433/tickets');
  await s`ALTER TABLE forge_runs ADD COLUMN IF NOT EXISTS protected_violations jsonb`;
  await s`ALTER TABLE forge_runs ADD COLUMN IF NOT EXISTS policy_waived_at timestamptz`;
  
  const r = await s`select column_name from information_schema.columns where table_name='forge_runs' and column_name in ('protected_violations','policy_waived_at')`;
  console.log(r.map(x=>x.column_name).sort());
  await s.end();
})();
