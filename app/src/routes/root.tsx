import { Link, Outlet } from "@tanstack/react-router";

export function Root() {
  return (
    <div style={{ display: "flex" }}>
      <nav style={{ width: 160, padding: 12 }}>
        <Link to="/">Tickets</Link><br />
        <Link to="/knowledge">Knowledge</Link><br />
        <Link to="/settings">Settings</Link>
      </nav>
      <main style={{ flex: 1, padding: 16 }}><Outlet /></main>
    </div>
  );
}
