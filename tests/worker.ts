// Minimal Worker for the `workers` test project. Tests import the code they
// exercise directly; this entry only exists so the pool has a `main`.
export default {
  fetch() {
    return new Response(null, { status: 404 });
  },
} satisfies ExportedHandler;
