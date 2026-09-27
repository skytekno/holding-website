import { notFound } from "next/navigation";
import { getPage, getPages } from "@/lib/api";
import { pageMetadata } from "@/lib/site";
import { HomePage } from "@/components/home-page";

export async function generateMetadata() {
  const page = await getPage("home");
  if (!page) return {};
  return pageMetadata(page);
}
export default async function Home() {
  const page = await getPage("home");
  if (!page) notFound();
  // A secondary page listing must not hide an otherwise available homepage.
  const pages = await getPages().catch(() => []);
  return <HomePage page={page} pages={pages} />;
}
