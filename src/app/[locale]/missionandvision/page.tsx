import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { isLocale, locales, localeMeta, type Locale } from "@/i18n/config";
import { getDictionary } from "@/i18n/dictionaries";
import { getPublicFeatureState } from "@/lib/feature-flags";
import { site, pages } from "@/lib/site";
import { MissionVision } from "@/components/sections/mission-vision";

export const dynamic = "force-dynamic";

const missionVisionPath = pages.missionVision;

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>;
}): Promise<Metadata> {
  const { locale } = await params;
  if (!isLocale(locale)) return {};

  const dict = await getDictionary(locale);
  const meta = dict.missionVision.meta;
  const path = `/${locale}${missionVisionPath}`;

  const languages = Object.fromEntries(
    locales.map((l) => [localeMeta[l].hreflang, `/${l}${missionVisionPath}`]),
  );

  return {
    title: meta.title,
    description: meta.description,
    alternates: {
      canonical: path,
      languages: { ...languages, "x-default": `/en${missionVisionPath}` },
    },
    openGraph: {
      type: "article",
      locale: localeMeta[locale].hreflang,
      url: `${site.url}${path}`,
      siteName: dict.brand.name,
      title: `${meta.title} · ${dict.brand.name}`,
      description: meta.description,
    },
    twitter: {
      card: "summary_large_image",
      title: `${meta.title} · ${dict.brand.name}`,
      description: meta.description,
    },
    robots: {
      index: true,
      follow: true,
      googleBot: { index: true, follow: true, "max-image-preview": "large" },
    },
  };
}

export default async function MissionAndVisionPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();

  const typedLocale = locale as Locale;
  const dict = await getDictionary(typedLocale);
  const features = await getPublicFeatureState(typedLocale);

  const mv = dict.missionVision;

  /** AboutPage schema so search engines understand this is the brand's story. */
  const aboutSchema = {
    "@context": "https://schema.org",
    "@type": "AboutPage",
    "@id": `${site.url}/${typedLocale}${missionVisionPath}#about`,
    url: `${site.url}/${typedLocale}${missionVisionPath}`,
    name: `${mv.meta.title} · ${dict.brand.name}`,
    description: mv.meta.description,
    inLanguage: localeMeta[typedLocale].hreflang,
    isPartOf: { "@id": `${site.url}/#business` },
    about: {
      "@type": "Organization",
      "@id": `${site.url}/#business`,
      name: dict.brand.name,
      slogan: dict.brand.tagline,
      url: site.url,
      email: site.email,
      telephone: site.phoneE164,
      areaServed: { "@type": "Country", name: "Morocco" },
      knowsAbout: mv.values.items.map((item) => item.title),
    },
  };

  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(aboutSchema) }}
      />
      <MissionVision locale={typedLocale} dict={dict} features={features} />
    </>
  );
}
