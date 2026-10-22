/**
 * Page-level layout primitives for the customer dashboard.
 *
 * The top bar already shows the section title, so a page header carries only
 * the one-line description and the primary actions. Cards are the `.panel`
 * surface with the brand's `rounded-3xl`; anything nested inside a card is an
 * `.inset` (tone step down), never a hairline box.
 */

import type { ReactNode } from "react";

export function PageHeader({
  title,
  description,
  actions,
}: {
  /** Only for pages whose heading differs from the section (a campaign name). */
  title?: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
}) {
  if (!title && !description && !actions) return null;
  return (
    <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
      <div className="min-w-0">
        {title && (
          <h1 className="display wrap-anywhere text-[1.5rem] text-white sm:text-[1.75rem]">{title}</h1>
        )}
        {description && (
          <p className={`max-w-2xl text-[15px] leading-6 text-muted ${title ? "mt-2" : ""}`}>
            {description}
          </p>
        )}
      </div>
      {actions && <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

export function Card({
  title,
  description,
  action,
  children,
  className = "",
}: {
  title?: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={`panel rounded-3xl p-5 sm:p-6 ${className}`}>
      {(title || action) && (
        <div className="mb-5 flex items-start justify-between gap-3">
          <div className="min-w-0">
            {title && <h2 className="text-base font-bold text-white">{title}</h2>}
            {description && <p className="mt-1 text-sm leading-6 text-muted">{description}</p>}
          </div>
          {action && <div className="flex shrink-0 items-center gap-2">{action}</div>}
        </div>
      )}
      {children}
    </section>
  );
}

/** Small label above a value or a group, sentence case, never uppercase. */
export function Label({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <p className={`text-xs font-semibold text-muted ${className}`}>{children}</p>;
}

/** Centered empty state inside a card. */
export function EmptyState({
  title,
  body,
  action,
}: {
  title: ReactNode;
  body?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="px-4 py-10 text-center sm:py-14">
      <p className="text-base font-bold text-white">{title}</p>
      {body && <p className="mx-auto mt-2 max-w-sm text-sm leading-6 text-muted">{body}</p>}
      {action && <div className="mt-6 flex justify-center">{action}</div>}
    </div>
  );
}
