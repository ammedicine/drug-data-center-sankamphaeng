"use client";

import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

const AXIS = { stroke: "#5b6b7c", fontSize: 11 };
const GRID = "#e3e8ee";
const SERIES = ["#0f9d8f", "#1d4ed8", "#97650a", "#b3261e", "#5b6b7c"];

function formatCompact(value: number): string {
  return value.toLocaleString("th-TH", { notation: "compact", maximumFractionDigits: 1 });
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
        <LineChart data={data} margin={{ top: 8, right: 12, bottom: 4, left: 4 }}>
          <CartesianGrid stroke={GRID} vertical={false} />
          <XAxis dataKey="period" tick={AXIS} tickLine={false} axisLine={{ stroke: GRID }} minTickGap={24} />
          <YAxis tick={AXIS} tickLine={false} axisLine={false} tickFormatter={formatCompact} width={52} />
          <Tooltip
            formatter={(value: number) => [value.toLocaleString("th-TH"), "ปริมาณจ่าย"]}
            contentStyle={{
              borderRadius: 10,
              border: "1px solid #e3e8ee",
              fontSize: 12,
              boxShadow: "0 4px 12px rgba(16,32,46,0.08)",
            }}
          />
          <Line
            type="monotone"
            dataKey="totalQuantity"
            stroke={SERIES[0]}
            strokeWidth={2}
            dot={false}
            activeDot={{ r: 4 }}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

/** Horizontal ranking chart (Top used drugs / facility comparison). */
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
        <BarChart data={data} layout="vertical" margin={{ top: 4, right: 16, bottom: 4, left: 8 }}>
          <CartesianGrid stroke={GRID} horizontal={false} />
          <XAxis type="number" tick={AXIS} tickLine={false} axisLine={false} tickFormatter={formatCompact} />
          <YAxis
            type="category"
            dataKey="label"
            tick={AXIS}
            tickLine={false}
            axisLine={{ stroke: GRID }}
            width={150}
          />
          <Tooltip
            formatter={(value: number) => [value.toLocaleString("th-TH"), "ปริมาณจ่าย"]}
            contentStyle={{ borderRadius: 10, border: "1px solid #e3e8ee", fontSize: 12 }}
          />
          <Bar dataKey="value" radius={[0, 4, 4, 0]} barSize={16}>
            {data.map((_, index) => (
              <Cell key={index} fill={SERIES[index % SERIES.length]} />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
