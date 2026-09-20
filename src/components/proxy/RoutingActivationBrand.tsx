import { useEffect, useRef, useState } from "react";
import { motion, useReducedMotion } from "framer-motion";
import { cn } from "@/lib/utils";

const BURST_LIFETIME_MS = 980;
const PARTICLES = [
  [-76, -16, 3, "#60a5fa"],
  [-63, 17, 2, "#22d3ee"],
  [-51, -25, 2, "#34d399"],
  [-38, 24, 4, "#34d399"],
  [-11, 27, 3, "#5eead4"],
  [19, 24, 2, "#34d399"],
  [47, 21, 2, "#60a5fa"],
  [76, 13, 2, "#34d399"],
] as const;

export function RoutingActivationBrand({
  active,
  contextKey,
  ready,
  href,
  label,
}: {
  active: boolean;
  contextKey: string;
  ready: boolean;
  href: string;
  label: string;
}) {
  const reducedMotion = useReducedMotion();
  const previous = useRef({ active, contextKey, ready });
  const [sequence, setSequence] = useState(0);
  const [burst, setBurst] = useState(false);

  useEffect(() => {
    const before = previous.current;
    const sameContext = before.contextKey === contextKey;
    const activated =
      before.ready && ready && sameContext && !before.active && active;
    previous.current = { active, contextKey, ready };

    if (!activated || reducedMotion) {
      if (!active || !sameContext || !ready) setBurst(false);
      return;
    }
    setSequence((value) => value + 1);
    setBurst(true);
    const timer = window.setTimeout(() => setBurst(false), BURST_LIFETIME_MS);
    return () => window.clearTimeout(timer);
  }, [active, contextKey, ready, reducedMotion]);

  return (
    <div className="relative isolate inline-flex items-center">
      {burst && (
        <motion.span
          key={`glow-${sequence}`}
          aria-hidden="true"
          className="pointer-events-none absolute -inset-x-3 -inset-y-2 -z-10 rounded-full bg-emerald-400/20 blur-md"
          initial={{ opacity: 0, scale: 0.4 }}
          animate={{ opacity: [0, 0.8, 0], scale: [0.4, 1.1, 1.45] }}
          transition={{ duration: 0.82 }}
        />
      )}
      <motion.a
        href={href}
        target="_blank"
        rel="noreferrer"
        className={cn(
          "relative z-10 text-xl font-semibold transition-colors duration-500",
          active
            ? "text-emerald-500 hover:text-emerald-600 dark:text-emerald-400 dark:hover:text-emerald-300"
            : "text-blue-500 hover:text-blue-600 dark:text-blue-400 dark:hover:text-blue-300",
        )}
        animate={burst ? { scale: [1, 0.96, 1.075, 1] } : { scale: 1 }}
        transition={{ duration: burst ? 0.72 : 0.28 }}
      >
        {label}
      </motion.a>
      {burst && (
        <motion.span
          key={`particles-${sequence}`}
          data-testid="routing-activation-particles"
          aria-hidden="true"
          className="pointer-events-none absolute left-1/2 top-1/2 z-20 h-0 w-0"
        >
          {PARTICLES.map(([x, y, size, color], index) => (
            <motion.span
              key={`${x}-${y}`}
              className="absolute block rounded-full"
              style={{
                width: size,
                height: size,
                backgroundColor: color,
                boxShadow: `0 0 ${size * 2 + 2}px ${color}`,
              }}
              initial={{ x: 0, y: 0, opacity: 0, scale: 0.2 }}
              animate={{ x, y, opacity: [0, 1, 0], scale: [0.2, 1, 0.25] }}
              transition={{ duration: 0.65, delay: index * 0.02 }}
            />
          ))}
        </motion.span>
      )}
    </div>
  );
}
