import { useEffect, useRef, type ReactNode } from "react";

export function HoverExpandRow({
  onExpand,
  className,
  children,
}: {
  onExpand: () => void;
  className?: string;
  children: ReactNode;
}) {
  const timer = useRef<ReturnType<typeof setTimeout>>();
  const expand = useRef(onExpand);
  expand.current = onExpand;
  const cancel = () => {
    clearTimeout(timer.current);
    timer.current = undefined;
  };
  useEffect(() => cancel, []);

  return (
    <div
      className={className}
      onPointerEnter={(event) => {
        if (event.pointerType !== "mouse") return;
        cancel();
        // Avoid opening editors while the pointer passes through the list.
        timer.current = setTimeout(() => expand.current(), 300);
      }}
      onPointerLeave={cancel}
      onPointerDownCapture={cancel}
      onClickCapture={cancel}
    >
      {children}
    </div>
  );
}
