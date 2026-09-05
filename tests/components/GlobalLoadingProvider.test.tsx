import type { ReactNode } from "react";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import {
  QueryClient,
  QueryClientProvider,
  useMutation,
} from "@tanstack/react-query";
import { expect, it } from "vitest";
import {
  GlobalLoadingProvider,
  useGlobalLoading,
} from "@/contexts/GlobalLoadingContext";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function renderWithGlobalLoading(children: ReactNode) {
  const queryClient = new QueryClient({
    defaultOptions: { mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <GlobalLoadingProvider delayMs={0}>{children}</GlobalLoadingProvider>
    </QueryClientProvider>,
  );
}

it("tracks manual async work and clears the indicator in finally", async () => {
  const task = deferred<void>();

  function Harness() {
    const { runWithLoading } = useGlobalLoading();
    return (
      <button onClick={() => void runWithLoading(() => task.promise)}>
        Start
      </button>
    );
  }

  renderWithGlobalLoading(<Harness />);
  fireEvent.click(screen.getByRole("button", { name: "Start" }));
  expect(await screen.findByRole("status")).toBeInTheDocument();

  await act(async () => task.resolve());
  await waitFor(() => expect(screen.queryByRole("status")).toBeNull());
});

it("automatically tracks TanStack mutations", async () => {
  const task = deferred<void>();

  function Harness() {
    const mutation = useMutation({ mutationFn: () => task.promise });
    return <button onClick={() => mutation.mutate()}>Mutate</button>;
  }

  renderWithGlobalLoading(<Harness />);
  fireEvent.click(screen.getByRole("button", { name: "Mutate" }));
  expect(await screen.findByRole("status")).toBeInTheDocument();

  await act(async () => task.resolve());
  await waitFor(() => expect(screen.queryByRole("status")).toBeNull());
});

it("stays visible until every overlapping manual task finishes", async () => {
  const first = deferred<void>();
  const second = deferred<void>();

  function Harness() {
    const { runWithLoading } = useGlobalLoading();
    return (
      <>
        <button onClick={() => void runWithLoading(() => first.promise)}>
          First
        </button>
        <button onClick={() => void runWithLoading(() => second.promise)}>
          Second
        </button>
      </>
    );
  }

  renderWithGlobalLoading(<Harness />);
  fireEvent.click(screen.getByRole("button", { name: "First" }));
  fireEvent.click(screen.getByRole("button", { name: "Second" }));
  expect(await screen.findByRole("status")).toBeInTheDocument();

  await act(async () => first.resolve());
  expect(screen.getByRole("status")).toBeInTheDocument();

  await act(async () => second.resolve());
  await waitFor(() => expect(screen.queryByRole("status")).toBeNull());
});
