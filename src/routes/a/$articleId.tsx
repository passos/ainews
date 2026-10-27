import { createFileRoute, notFound } from "@tanstack/react-router";
import { ArticleReader } from "../../components/ArticleReader";
import { SITE_NAME } from "../../lib/site";
import { getArticle } from "../../server/publication/api";

export async function loadArticle(
  params: { articleId: string },
  fns = {
    getArticle: (articleId: number) => getArticle({ data: { articleId } }),
  },
) {
  if (!/^[1-9]\d{0,15}$/.test(params.articleId)) throw notFound();
  const page = await fns.getArticle(Number(params.articleId));
  if (!page) throw notFound();
  return { page };
}

export const Route = createFileRoute("/a/$articleId")({
  loader: ({ params }) => loadArticle(params),
  head: ({ loaderData }) => ({
    meta: [
      {
        title: loaderData
          ? `${loaderData.page.article.title} — ${SITE_NAME}`
          : SITE_NAME,
      },
    ],
    links: loaderData?.page.article.url
      ? [{ rel: "canonical", href: loaderData.page.article.url }]
      : [],
  }),
  notFoundComponent: () => <p className="pt-6 text-sm">No such article.</p>,
  component: ArticlePageView,
});

function ArticlePageView() {
  return <ArticleReader page={Route.useLoaderData().page} />;
}
