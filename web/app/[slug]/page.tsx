import { notFound, permanentRedirect } from "next/navigation";
import { getPage } from "@/lib/api";
import { pageMetadata } from "@/lib/site";
import { ContentPage } from "@/components/content-page";

type Props = { params: Promise<{ slug: string }> };
export async function generateMetadata({ params }: Props) {
  const { slug } = await params;
  const page = await getPage(slug);
  return page ? pageMetadata(page) : {};
}
export default async function PublicPage({ params }: Props) {
  const { slug } = await params;
  if (slug === "home") permanentRedirect("/");
  const page = await getPage(slug);
  if (!page) notFound();
  return <ContentPage page={page} />;
}
