"use client";

import {
  Bar,
  CartesianGrid,
  ComposedChart,
  Legend,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

const AXIS_COLOR = "#6f8291";
const GRID_COLOR = "#e7edf2";

function compact(value: number): string {
  return value.toLocaleString("th-TH", { notation: "compact", maximumFractionDigits: 1 });
}

function dateLabel(value: string): string {
  const date = new Date(`${value}T00:00:00`);
  return Number.isNaN(date.getTime())
    ? value
    : new Intl.DateTimeFormat("th-TH", { day: "numeric", month: "short" }).format(date);
}

export function DashboardTrendChart({
  data,
  height = 320,
}: {
  data: Array<{ period: string; totalQuantity: number; dispensingRows: number }>;
  height?: number;
}) {
  return (
    <div
      role="img"
      aria-label="กราฟแนวโน้มจำนวนรายการจ่ายยาและปริมาณใช้รายวัน"
      style={{ height }}
    >
      <ResponsiveContainer width="100%" height="100%">
        <ComposedChart data={data} margin={{ top: 10, right: 4, bottom: 0, left: -8 }}>
          <defs>
            <linearGradient id="dashboardBarFill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#57a8ff" stopOpacity={0.82} />
              <stop offset="100%" stopColor="#57a8ff" stopOpacity={0.22} />
            </linearGradient>
          </defs>
          <CartesianGrid stroke={GRID_COLOR} vertical={false} />
          <XAxis
            dataKey="period"
            tick={{ fill: AXIS_COLOR, fontSize: 11.5 }}
            tickFormatter={dateLabel}
            tickLine={false}
            axisLine={{ stroke: GRID_COLOR }}
            minTickGap={34}
            tickMargin={10}
          />
          <YAxis
            yAxisId="rows"
            tick={{ fill: AXIS_COLOR, fontSize: 11.5 }}
            tickFormatter={compact}
            tickLine={false}
            axisLine={false}
            width={46}
          />
          <YAxis
            yAxisId="quantity"
            orientation="right"
            tick={{ fill: AXIS_COLOR, fontSize: 11.5 }}
            tickFormatter={compact}
            tickLine={false}
            axisLine={false}
            width={46}
          />
          <Tooltip
            labelFormatter={(label) => dateLabel(String(label))}
            formatter={(value: number, name: string) => [
              value.toLocaleString("th-TH"),
              name === "dispensingRows" ? "รายการจ่ายยา" : "ปริมาณใช้",
            ]}
            contentStyle={{
              border: "1px solid #dbe5ec",
              borderRadius: 10,
              boxShadow: "0 10px 28px rgba(23, 63, 92, 0.12)",
              fontSize: 12.5,
            }}
            cursor={{ fill: "rgba(61, 146, 235, 0.06)" }}
          />
          <Legend
            formatter={(value) => (value === "dispensingRows" ? "รายการจ่ายยา" : "ปริมาณใช้")}
            iconType="circle"
            iconSize={8}
            wrapperStyle={{ fontSize: 12, color: AXIS_COLOR, paddingTop: 8 }}
          />
          <Bar
            yAxisId="rows"
            dataKey="dispensingRows"
            fill="url(#dashboardBarFill)"
            radius={[4, 4, 0, 0]}
            maxBarSize={22}
          />
          <Line
            yAxisId="quantity"
            type="monotone"
            dataKey="totalQuantity"
            stroke="#08a68f"
            strokeWidth={2.25}
            dot={false}
            activeDot={{ r: 4, fill: "#08a68f", stroke: "white", strokeWidth: 2 }}
          />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}
