export const lastVirtuosoProps: { current: any } = { current: null };

export function Virtuoso(props: any) {
  lastVirtuosoProps.current = props;
  const { data = [], itemContent, computeItemKey } = props;
  return (
    <div data-testid="virtuoso">
      {data.map((item: any, i: number) => (
        <div
          data-testid="virtuoso-row"
          key={computeItemKey ? computeItemKey(i, item) : i}
        >
          {itemContent ? itemContent(i, item) : item}
        </div>
      ))}
    </div>
  );
}
