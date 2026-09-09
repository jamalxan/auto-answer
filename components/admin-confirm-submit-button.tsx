"use client";

/**
 * A native `confirm()` guard in front of a destructive server action, as a
 * plain submit button with its own `formAction` — for use *inside* an
 * existing `<form>` (e.g. next to that form's own Save button) rather than
 * AdminConfirmForm's self-contained `<form>`. HTML forms can't nest, and
 * React's direct-DOM rendering doesn't stop you from trying: nest an
 * AdminConfirmForm inside another `<form>` and submitting either one fires
 * both actions — see the pricing page, which edits and deletes the same
 * plan from one `<form>` and hit exactly that.
 */
export default function AdminConfirmSubmitButton({
  formAction,
  confirmMessage,
  label,
  className,
}: {
  formAction: (formData: FormData) => void;
  confirmMessage: string;
  label: string;
  className?: string;
}) {
  return (
    <button
      type="submit"
      formAction={formAction}
      onClick={(e) => {
        if (!window.confirm(confirmMessage)) {
          e.preventDefault();
        }
      }}
      className={
        className ??
        "label-mono rounded border-2 border-border px-2.5 py-1 text-[10px] font-bold text-foreground transition hover:border-border-hover hover:bg-surface-hover"
      }
    >
      {label}
    </button>
  );
}
