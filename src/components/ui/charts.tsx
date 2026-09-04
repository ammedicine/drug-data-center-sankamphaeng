"use client";

import {
  Bar,
  BarChart,
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

/**
 * Charts support the tables; they never carry information the table does not.
 * One series means one colour - a ranking of ten drugs is still one measure, so
 * it stays one colour rather than becoming a rainbow.
 */
const INK = "#17252f";
const MUTED = "#64798a";
const GRID = "#eaeef1";
const SERIES = "#087a70";

const AXIS = { stroke: MUTED, fontSize: 12 } as const;

const TOOLTIP_STYLE = {
  borderRadius: 8,
  border: "1px solid #dfe5e9",
  fontSize: 12.5,
  color: INK,
  padding: "6px 10px",
  boxShadow: "0 2px 8px rgba(23,37,47,0.08)",
} as const;

function formatCompact(value: number): string {
  return value.toLocaleString("th-TH", { notation: "compact", maximumFractionDigits: 1 });
}

function formatFull(value: number): string {
  return value.toLocaleString("th-TH");
}

/** Usage over time (PROJECT_SPEC section 17 - Usage Trend). */
export function TrendChart({
  data,
  height = 260,
}: {
  data: Array<{ period: string; totalQuantity: number }>;
  height?: number;
}) {
  return (
    <div style={{ height }}>
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
          <CartesianGrid stroke={GRID} vertical={false} />
          <XAxis
            dataKey="period"
            tick={AXIS}
            tickLine={false}
            axisLine={{ stroke: GRID }}
            minTickGap={28}
            tickMargin={8}
          />
          <YAxis
            tick={AXIS}
            tickLine={false}
            axisLine={false}
            tickFormatter={formatCompact}
            width={48}
          />
          <Tooltip
            formatter={(value: number) => [formatFull(value), "ปริมาณจ่าย"]}
            contentStyle={TOOLTIP_STYLE}
            cursor={{ stroke: MUTED, strokeDasharray: "3 3" }}
          />
          <Line
            type="monotone"
            dataKey="totalQuantity"
            stroke={SERIES}
            strokeWidth={1.75}
            dot={false}
            activeDot={{ r: 3.5, strokeWidth: 0 }}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

/** Horizontal ranking (top used drugs / facility comparison). */
export function RankingChart({
  data,
  height = 300,
}: {
  data: Array<{ label: string; value: number }>;
  height?: number;
}) {
  return (
    <div style={{ height }}>
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} layout="vertical" margin={{ top: 4, right: 16, bottom: 0, left: 0 }}>
          <CartesianGrid stroke={GRID} horizontal={false} />
          <XAxis
            type="number"
            tick={AXIS}
            tickLine={false}
            axisLine={false}
            tickFormatter={formatCompact}
          />
          <YAxis
            type="category"
            dataKey="label"
            tick={{ ...AXIS, fontSize: 11.5 }}
            tickLine={false}
            axisLine={{ stroke: GRID }}
            width={148}
          />
          <Tooltip
            formatter={(value: number) => [formatFull(value), "ปริมาณจ่าย"]}
            contentStyle={TOOLTIP_STYLE}
            cursor={{ fill: "rgba(8,122,112,0.06)" }}
          />
          <Bar dataKey="value" fill={SERIES} radius={[0, 3, 3, 0]} barSize={13} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
