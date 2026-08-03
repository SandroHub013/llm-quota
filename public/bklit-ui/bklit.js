// Bklit UI Component Engine

// Theme Switcher Logic
document.addEventListener('DOMContentLoaded', () => {
  const themeBtns = document.querySelectorAll('.theme-btn');
  themeBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      themeBtns.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      const theme = btn.dataset.theme;
      if (theme === 'lagoon') {
        document.documentElement.removeAttribute('data-theme');
      } else {
        document.documentElement.setAttribute('data-theme', theme);
      }
    });
  });

  // Render all components
  initBklitComponents();
});

function initBklitComponents() {
  renderAreaChart();
  renderBarChart();
  renderGaugeChart();
  renderHeatmapChart();
  renderProfitLossChart();
  renderLiveLineChart();
  renderRadarChart();
  renderFunnelChart();
}

/* 1. Bklit Area Chart (Curved Gradient & Hover Crosshair) */
function renderAreaChart() {
  const svg = document.getElementById('area-chart-svg');
  if (!svg) return;

  const data = [
    { label: 'Jan', v1: 30, v2: 15 },
    { label: 'Feb', v1: 45, v2: 25 },
    { label: 'Mar', v1: 35, v2: 40 },
    { label: 'Apr', v1: 70, v2: 50 },
    { label: 'May', v1: 65, v2: 60 },
    { label: 'Jun', v1: 90, v2: 75 },
    { label: 'Jul', v1: 85, v2: 70 }
  ];

  const width = 400;
  const height = 180;
  const padding = 20;

  const maxX = data.length - 1;
  const maxY = 100;

  const getX = (i) => padding + (i / maxX) * (width - 2 * padding);
  const getY = (v) => height - padding - (v / maxY) * (height - 2 * padding);

  // Generate smooth cubic bezier curves
  const points1 = data.map((d, i) => [getX(i), getY(d.v1)]);
  const points2 = data.map((d, i) => [getX(i), getY(d.v2)]);

  const pathD1 = createSmoothPath(points1);
  const areaD1 = `${pathD1} L ${getX(maxX)},${height - padding} L ${getX(0)},${height - padding} Z`;

  const pathD2 = createSmoothPath(points2);
  const areaD2 = `${pathD2} L ${getX(maxX)},${height - padding} L ${getX(0)},${height - padding} Z`;

  svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
  svg.innerHTML = `
    <defs>
      <linearGradient id="areaGlow1" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="var(--chart-1)" stop-opacity="0.4"/>
        <stop offset="100%" stop-color="var(--chart-1)" stop-opacity="0.0"/>
      </linearGradient>
      <linearGradient id="areaGlow2" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="var(--chart-3)" stop-opacity="0.25"/>
        <stop offset="100%" stop-color="var(--chart-3)" stop-opacity="0.0"/>
      </linearGradient>
    </defs>
    <!-- Background Grid Lines -->
    <line x1="${padding}" y1="${getY(25)}" x2="${width - padding}" y2="${getY(25)}" stroke="var(--border-color)" stroke-dasharray="4"/>
    <line x1="${padding}" y1="${getY(50)}" x2="${width - padding}" y2="${getY(50)}" stroke="var(--border-color)" stroke-dasharray="4"/>
    <line x1="${padding}" y1="${getY(75)}" x2="${width - padding}" y2="${getY(75)}" stroke="var(--border-color)" stroke-dasharray="4"/>

    <!-- Series 2 Area & Line -->
    <path d="${areaD2}" fill="url(#areaGlow2)"/>
    <path d="${pathD2}" fill="none" stroke="var(--chart-3)" stroke-width="2"/>

    <!-- Series 1 Area & Line -->
    <path d="${areaD1}" fill="url(#areaGlow1)"/>
    <path d="${pathD1}" fill="none" stroke="var(--chart-1)" stroke-width="2.5"/>

    <!-- Interactive Circles -->
    ${points1.map(([x, y]) => `<circle cx="${x}" cy="${y}" r="4" fill="var(--bg-card)" stroke="var(--chart-1)" stroke-width="2"/>`).join('')}
  `;
}

/* 2. Bklit Bar Chart (Stacked & Grouped Rounded Bars) */
function renderBarChart() {
  const svg = document.getElementById('bar-chart-svg');
  if (!svg) return;

  const data = [
    { cat: 'Mon', a: 40, b: 30 },
    { cat: 'Tue', a: 65, b: 20 },
    { cat: 'Wed', a: 50, b: 45 },
    { cat: 'Thu', a: 80, b: 35 },
    { cat: 'Fri', a: 95, b: 50 },
    { cat: 'Sat', a: 60, b: 40 }
  ];

  const width = 400;
  const height = 180;
  const padding = 25;
  const barWidth = 18;

  const getX = (i) => padding + (i / data.length) * (width - 2 * padding) + 15;
  const getY = (v) => height - padding - (v / 140) * (height - 2 * padding);

  svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
  svg.innerHTML = `
    <!-- Grid -->
    <line x1="${padding}" y1="${height - padding}" x2="${width - padding}" y2="${height - padding}" stroke="var(--border-color)"/>

    ${data.map((d, i) => {
      const x = getX(i);
      const hA = (d.a / 140) * (height - 2 * padding);
      const hB = (d.b / 140) * (height - 2 * padding);
      const yA = height - padding - hA;
      const yB = yA - hB;

      return `
        <!-- Stacked Bar B -->
        <rect x="${x}" y="${yB}" width="${barWidth}" height="${hB}" rx="4" fill="var(--chart-3)"/>
        <!-- Stacked Bar A -->
        <rect x="${x}" y="${yA}" width="${barWidth}" height="${hA}" rx="4" fill="var(--chart-1)"/>
        <!-- Category Label -->
        <text x="${x + barWidth/2}" y="${height - 5}" font-size="10" fill="var(--text-muted)" font-family="var(--font-mono)" text-anchor="middle">${d.cat}</text>
      `;
    }).join('')}
  `;
}

/* 3. Bklit Gauge Chart (Arc Metric & Center Readout) */
function renderGaugeChart() {
  const svg = document.getElementById('gauge-chart-svg');
  if (!svg) return;

  const percentage = 78;
  const cx = 100;
  const cy = 100;
  const r = 75;
  const startAngle = -210;
  const endAngle = 30;

  const totalAngle = endAngle - startAngle;
  const currentAngle = startAngle + (percentage / 100) * totalAngle;

  const polarToCartesian = (centerX, centerY, radius, angleInDegrees) => {
    const angleInRadians = (angleInDegrees * Math.PI) / 180.0;
    return {
      x: centerX + radius * Math.cos(angleInRadians),
      y: centerY + radius * Math.sin(angleInRadians)
    };
  };

  const bgStart = polarToCartesian(cx, cy, r, startAngle);
  const bgEnd = polarToCartesian(cx, cy, r, endAngle);
  const bgArcD = `M ${bgStart.x} ${bgStart.y} A ${r} ${r} 0 1 1 ${bgEnd.x} ${bgEnd.y}`;

  const valEnd = polarToCartesian(cx, cy, r, currentAngle);
  const valArcD = `M ${bgStart.x} ${bgStart.y} A ${r} ${r} 0 ${percentage > 50 ? 1 : 0} 1 ${valEnd.x} ${valEnd.y}`;

  svg.setAttribute('viewBox', `0 0 200 160`);
  svg.innerHTML = `
    <defs>
      <linearGradient id="gaugeGrad" x1="0" y1="0" x2="1" y2="0">
        <stop offset="0%" stop-color="var(--chart-3)"/>
        <stop offset="100%" stop-color="var(--chart-1)"/>
      </linearGradient>
    </defs>
    <!-- Background Arc -->
    <path d="${bgArcD}" fill="none" stroke="var(--bg-muted)" stroke-width="12" stroke-linecap="round"/>
    <!-- Value Arc -->
    <path d="${valArcD}" fill="none" stroke="url(#gaugeGrad)" stroke-width="12" stroke-linecap="round"/>
    <!-- Center Metric Text -->
    <text x="${cx}" y="${cy}" font-size="28" font-weight="700" fill="var(--text-main)" font-family="var(--font-mono)" text-anchor="middle">${percentage}%</text>
    <text x="${cx}" y="${cy + 20}" font-size="10" fill="var(--text-muted)" font-family="var(--font-mono)" text-anchor="middle">OPTIMAL</text>
  `;
}

/* 4. Bklit Heatmap (7x24 Matrix Grid) */
function renderHeatmapChart() {
  const container = document.getElementById('heatmap-container');
  if (!container) return;

  container.innerHTML = '';
  for (let i = 0; i < 96; i++) {
    const val = Math.random();
    const cell = document.createElement('div');
    cell.className = 'heatmap-cell';
    
    if (val > 0.8) {
      cell.style.background = 'var(--chart-1)';
    } else if (val > 0.5) {
      cell.style.background = 'var(--chart-2)';
    } else if (val > 0.25) {
      cell.style.background = 'var(--chart-3)';
    } else {
      cell.style.background = 'var(--bg-muted)';
    }
    cell.title = `Activity Score: ${Math.round(val * 100)}`;
    container.appendChild(cell);
  }
}

/* 5. Bklit Profit & Loss Baseline Chart */
function renderProfitLossChart() {
  const svg = document.getElementById('profit-loss-svg');
  if (!svg) return;

  const data = [12, 28, -15, -8, 42, 60, -22, 35, 50, -5, 30];
  const width = 400;
  const height = 180;
  const padding = 20;

  const zeroY = height / 2;
  const getX = (i) => padding + (i / (data.length - 1)) * (width - 2 * padding);
  const getY = (v) => zeroY - (v / 70) * (height / 2 - padding);

  const points = data.map((v, i) => [getX(i), getY(v)]);
  const pathD = points.reduce((acc, p, i) => `${acc} ${i === 0 ? 'M' : 'L'} ${p[0]},${p[1]}`, '');

  svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
  svg.innerHTML = `
    <!-- Baseline Zero Line -->
    <line x1="${padding}" y1="${zeroY}" x2="${width - padding}" y2="${zeroY}" stroke="var(--text-muted)" stroke-dasharray="3"/>
    
    <!-- Path Line -->
    <path d="${pathD}" fill="none" stroke="var(--chart-1)" stroke-width="2.5"/>

    <!-- Data Nodes with Positive/Negative Colors -->
    ${data.map((v, i) => {
      const [x, y] = points[i];
      const color = v >= 0 ? 'var(--chart-positive)' : 'var(--chart-negative)';
      return `<circle cx="${x}" cy="${y}" r="4" fill="${color}"/>`;
    }).join('')}
  `;
}

/* 6. Bklit Live Line Stream Chart */
let liveStreamTimer = null;
function renderLiveLineChart() {
  const svg = document.getElementById('live-stream-svg');
  if (!svg) return;

  let streamData = Array.from({ length: 20 }, () => 40 + Math.random() * 30);

  const updateChart = () => {
    streamData.shift();
    streamData.push(35 + Math.random() * 45);

    const width = 400;
    const height = 180;
    const padding = 15;

    const getX = (i) => padding + (i / (streamData.length - 1)) * (width - 2 * padding);
    const getY = (v) => height - padding - (v / 100) * (height - 2 * padding);

    const points = streamData.map((v, i) => [getX(i), getY(v)]);
    const pathD = createSmoothPath(points);

    svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
    svg.innerHTML = `
      <defs>
        <linearGradient id="liveGlow" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="var(--chart-1)" stop-opacity="0.3"/>
          <stop offset="100%" stop-color="var(--chart-1)" stop-opacity="0.0"/>
        </linearGradient>
      </defs>
      <path d="${pathD} L ${width - padding},${height - padding} L ${padding},${height - padding} Z" fill="url(#liveGlow)"/>
      <path d="${pathD}" fill="none" stroke="var(--chart-1)" stroke-width="2.5"/>
      <circle cx="${points[points.length - 1][0]}" cy="${points[points.length - 1][1]}" r="5" fill="var(--chart-1)"/>
    `;
  };

  if (liveStreamTimer) clearInterval(liveStreamTimer);
  liveStreamTimer = setInterval(updateChart, 1000);
  updateChart();
}

/* 7. Bklit Radar Chart (Spider Polygon) */
function renderRadarChart() {
  const svg = document.getElementById('radar-svg');
  if (!svg) return;

  const categories = ['Latency', 'Throughput', 'Accuracy', 'Uptime', 'Memory', 'CPU'];
  const values = [85, 70, 95, 90, 60, 75];
  const cx = 100;
  const cy = 90;
  const radius = 65;

  const getPoint = (i, val) => {
    const angle = (Math.PI * 2 / categories.length) * i - Math.PI / 2;
    const r = (val / 100) * radius;
    return [cx + r * Math.cos(angle), cy + r * Math.sin(angle)];
  };

  const points = values.map((v, i) => getPoint(i, v));
  const polygonD = points.reduce((acc, p, i) => `${acc} ${i === 0 ? 'M' : 'L'} ${p[0]},${p[1]}`, '') + ' Z';

  // Grid Rings
  const gridRings = [0.25, 0.5, 0.75, 1.0].map(scale => {
    const ringPts = categories.map((_, i) => getPoint(i, scale * 100));
    return ringPts.reduce((acc, p, i) => `${acc} ${i === 0 ? 'M' : 'L'} ${p[0]},${p[1]}`, '') + ' Z';
  });

  svg.setAttribute('viewBox', `0 0 200 180`);
  svg.innerHTML = `
    <!-- Grid Rings -->
    ${gridRings.map(d => `<path d="${d}" fill="none" stroke="var(--border-color)" stroke-dasharray="2"/>`).join('')}

    <!-- Filled Polygon -->
    <path d="${polygonD}" fill="var(--chart-glow)" stroke="var(--chart-1)" stroke-width="2"/>
    
    <!-- Category Labels -->
    ${categories.map((cat, i) => {
      const [x, y] = getPoint(i, 115);
      return `<text x="${x}" y="${y}" font-size="8" fill="var(--text-muted)" font-family="var(--font-mono)" text-anchor="middle">${cat}</text>`;
    }).join('')}
  `;
}

/* 8. Bklit Funnel Conversion Chart */
function renderFunnelChart() {
  const svg = document.getElementById('funnel-svg');
  if (!svg) return;

  const stages = [
    { label: 'Impressions', count: '120k', width: 340 },
    { label: 'Clicks', count: '45k', width: 260 },
    { label: 'Signups', count: '12k', width: 180 },
    { label: 'Active Users', count: '4.8k', width: 110 }
  ];

  const height = 180;
  const stageHeight = 35;
  const startY = 10;
  const cx = 200;

  svg.setAttribute('viewBox', `0 0 400 ${height}`);
  svg.innerHTML = stages.map((s, i) => {
    const y1 = startY + i * (stageHeight + 6);
    const y2 = y1 + stageHeight;
    const w1 = s.width;
    const w2 = stages[i + 1] ? stages[i + 1].width : s.width * 0.7;

    const pathD = `M ${cx - w1/2},${y1} L ${cx + w1/2},${y1} L ${cx + w2/2},${y2} L ${cx - w2/2},${y2} Z`;
    const opacity = 1 - i * 0.2;

    return `
      <path d="${pathD}" fill="var(--chart-1)" opacity="${opacity}"/>
      <text x="${cx}" y="${y1 + 22}" font-size="11" font-weight="600" fill="var(--bg-card)" font-family="var(--font-mono)" text-anchor="middle">${s.label}: ${s.count}</text>
    `;
  }).join('');
}

// Utility: Smooth Bezier Path Helper
function createSmoothPath(points) {
  return points.reduce((acc, point, i, a) => {
    if (i === 0) return `M ${point[0]},${point[1]}`;
    const prev = a[i - 1];
    const cp1x = prev[0] + (point[0] - prev[0]) / 2;
    const cp1y = prev[1];
    const cp2x = prev[0] + (point[0] - prev[0]) / 2;
    const cp2y = point[1];
    return `${acc} C ${cp1x},${cp1y} ${cp2x},${cp2y} ${point[0]},${point[1]}`;
  }, '');
}
