import { createFileRoute, Outlet } from "@tanstack/react-router";
import { AdminLayoutView } from "../../components/admin/AdminLayout";
import { getAdminIdentity } from "../../server/admin/identity";

export const Route = createFileRoute("/admin")({
  ssr: "data-only",
  loader: () => getAdminIdentity(),
  component: AdminLayout,
});

function AdminLayout() {
  const { email } = Route.useLoaderData();
  return (
    <AdminLayoutView email={email}>
      <Outlet />
    </AdminLayoutView>
  );
}
