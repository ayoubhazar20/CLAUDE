import { DOCUMENT_CSS } from "@/domain/render-html";

/**
 * Renders the (escaped / sanitised) document HTML produced by the shared renderer,
 * with the shared stylesheet — identical output to the public page and PDF source.
 */
export function DocumentFrame({ html }: { html: string }) {
  return (
    <>
      <style>{DOCUMENT_CSS}</style>
      <div dangerouslySetInnerHTML={{ __html: html }} />
    </>
  );
}
