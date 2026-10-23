import { useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { getAdminIdentity } from "../../server/admin/identity";

export const Route = createFileRoute("/admin/")({
  ssr: "data-only",
  loader: () => getAdminIdentity(),
  component: AdminHome,
});

function AdminHome() {
  const { email } = Route.useLoaderData();
  const [check, setCheck] = useState<string | null>(null);

  // Calls the server function from the browser, through /_serverFn. This
  // shows whether the CF_Authorization cookie reaches it.
  async function checkSession() {
    try {
      const result = await getAdminIdentity();
      setCheck(result.email);
    } catch (error) {
      if (error instanceof Response) setCheck(String(error.status));
      else setCheck(error instanceof Error ? error.message : String(error));
    }
  }

  return (
    <main>
      <h1>Admin</h1>
      <p>Signed in as {email}</p>
      <button type="button" onClick={checkSession}>
        Check session
      </button>
      {check !== null && <p>Session: {check}</p>}
    </main>
  );
}
