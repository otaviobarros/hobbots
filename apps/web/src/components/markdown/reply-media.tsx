import { Button } from "@hobbots/ui/components/button";
import { type ReactNode, useState } from "react";
import { type HastNode, hasImage, hastText } from "./hast-text.ts";
import { shownUrl, showsItsUrl, urlHost } from "./links.ts";
import { messages } from "./messages.ts";

const linkStyle = "text-lantern underline underline-offset-2 hover:text-lantern-hover";

/**
 * A link in a reply. It opens in the browser, outside the app, and shows its address beside its
 * text unless the text is the address. A link to anything but a web address shows as text. An
 * image inside a link, such as a badge, keeps its own Show image button outside the link.
 */
export function ReplyLink({
  href,
  node,
  children,
}: {
  href: string | undefined;
  node: HastNode | undefined;
  children: ReactNode;
}) {
  if (!href) return <span>{children}</span>;
  const opens = {
    href,
    target: "_blank",
    rel: "noopener noreferrer",
    title: messages.link.opensOutside({ url: href }),
  };
  const address = (
    <span className="ms-1 inline-block text-xs text-label">{messages.link.address({ url: shownUrl(href) })}</span>
  );
  if (node !== undefined && hasImage(node)) {
    return (
      <span>
        {children}
        <a {...opens} className={linkStyle}>
          {address}
        </a>
      </span>
    );
  }
  return (
    <a {...opens} className={linkStyle}>
      {children}
      {(node === undefined || !showsItsUrl(hastText(node), href)) && address}
    </a>
  );
}

/**
 * An image in a reply. Nothing loads until the reader asks, so a reply cannot fetch a remote image,
 * such as a tracking pixel, on its own. Only `https:` images load; any other shows its description.
 */
export function ReplyImage({ src, alt }: { src: string | undefined; alt: string | undefined }) {
  const [shown, setShown] = useState(false);
  if (!src?.startsWith("https:")) return alt ? <span className="text-secondary-text">{alt}</span> : null;
  if (shown) return <img src={src} alt={alt ?? ""} referrerPolicy="no-referrer" className="max-w-full" />;
  const host = urlHost(src);
  return (
    <Button variant="outline" size="xs" onClick={() => setShown(true)}>
      {alt ? messages.image.loadNamed({ alt, host }) : messages.image.load({ host })}
    </Button>
  );
}
