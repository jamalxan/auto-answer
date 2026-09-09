"use client";

/**
 * A native `confirm()` guard in front of a one-click admin server action —
 * for actions with real, immediate effect (suspending a customer workspace,
 * deleting a pricing plan) that shouldn't fire on a stray click.
 */
export default function AdminConfirmForm({
  action,
  confirmMessage,
  hiddenFields,
  label,
  className,
}: {
  action: (formData: FormData) => void;
  confirmMessage: string;
  hiddenFields: Record<string, string>;
  label: string;
  className?: string;
}) {
  return (
    <form
      action={action}
      onSubmit={(e) => {
        if (!window.confirm(confirmMessage)) {
          e.preventDefault();
        }
      }}
    >
      {Object.entries(hiddenFields).map(([name, value]) => (
        <input key={name} type="hidden" name={name} value={value} />
      ))}
      <button
        type="submit"
        className={
          className ??
          "label-mono rounded border-2 border-border px-2.5 py-1 text-[10px] font-bold text-foreground transition hover:border-border-hover hover:bg-surface-hover"
        }
      >
        {label}
      </button>
    </form>
  );
}
