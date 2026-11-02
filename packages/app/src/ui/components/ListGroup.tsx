import { Children, Fragment, isValidElement, type ReactNode } from "react";
import { View } from "react-native";
import { HAIRLINE } from "./classes.ts";

export interface ListGroupProps {
  children: ReactNode;
}

function rowKey(row: ReactNode): string {
  if (isValidElement(row) && row.key !== null) return row.key;
  return `row-${String(row)}`;
}

export function ListGroup({ children }: ListGroupProps) {
  const rows = Children.toArray(children);

  return (
    <View
      className="overflow-hidden rounded-group border-border bg-surface"
      style={{ borderWidth: HAIRLINE }}
    >
      {rows.map((row, index) => (
        <Fragment key={rowKey(row)}>
          {index > 0 ? <View className="bg-border" style={{ height: HAIRLINE }} /> : null}
          {row}
        </Fragment>
      ))}
    </View>
  );
}
