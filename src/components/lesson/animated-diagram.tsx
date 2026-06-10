'use client';

import { useState } from 'react';
import type { animatedDiagramSchema, diagramShapeSchema } from '@/server/lessons/blocks';
import type { z } from 'zod';

type AnimatedDiagramBlock = z.infer<typeof animatedDiagramSchema>;
type DiagramShape = z.infer<typeof diagramShapeSchema>;

type Props = {
  block: AnimatedDiagramBlock;
};

/**
 * AnimatedDiagram block — step-through SVG renderer.
 *
 * Layout contract:
 *   - SVG viewBox "0 0 100 60" — shapes use percentage coords directly.
 *   - Highlighted shapes (current step's highlightIds) get a sun-300 fill/stroke.
 *   - CSS transition on fill/stroke (honours global reduced-motion rule via globals.css).
 *   - Unknown highlightIds are silently ignored at render (validator catches them
 *     before the lesson is persisted — see validate.ts).
 *   - aria-live caption region updated on each step change.
 *   - testids: animated-diagram (root), diagram-step (next-step button).
 *
 * Reduced motion: handled globally via the rule in globals.css
 * (`transition-duration: 0.01ms !important` under prefers-reduced-motion).
 * No per-component guard is needed.
 */
export function AnimatedDiagram({ block }: Props) {
  const [stepIndex, setStepIndex] = useState(0);

  const currentStep = block.steps[stepIndex];
  const isLastStep = stepIndex >= block.steps.length - 1;
  const highlightSet = new Set(currentStep?.highlightIds ?? []);

  function handleNext() {
    setStepIndex((i) => Math.min(i + 1, block.steps.length - 1));
  }

  function handlePrev() {
    setStepIndex((i) => Math.max(i - 1, 0));
  }

  return (
    <div
      data-testid="animated-diagram"
      className="mt-6 rounded-xl border border-sky-200 bg-sky-50 px-6 py-5"
    >
      {/* Header */}
      <div className="flex items-center justify-between mb-3">
        <p className="text-xs font-medium uppercase tracking-wide text-sky-500">Diagram</p>
        <p className="text-xs text-sky-400">
          step {stepIndex + 1} of {block.steps.length}
        </p>
      </div>

      <p className="text-sm font-semibold text-ink-900 mb-3">{block.title}</p>

      {/* SVG canvas */}
      <div className="rounded-lg border border-sky-200 bg-white overflow-hidden">
        <svg
          viewBox="0 0 100 60"
          xmlns="http://www.w3.org/2000/svg"
          className="w-full"
          aria-hidden="true"
          style={{ display: 'block' }}
        >
          {block.shapes.map((shape) => (
            <ShapeRenderer
              key={shape.id}
              shape={shape}
              highlighted={highlightSet.has(shape.id)}
            />
          ))}
        </svg>
      </div>

      {/* Step caption — aria-live so screen readers announce on step change */}
      <p
        aria-live="polite"
        aria-atomic="true"
        className="mt-3 text-sm text-ink-700 min-h-[2.5rem]"
      >
        {currentStep?.caption ?? ''}
      </p>

      {/* Navigation */}
      <div className="mt-3 flex items-center gap-3">
        <button
          onClick={handlePrev}
          disabled={stepIndex === 0}
          aria-label="Previous diagram step"
          className="rounded-lg border border-sky-200 bg-white px-4 py-2 text-sm text-sky-600 hover:border-sky-400 hover:bg-sky-50 disabled:opacity-40 disabled:cursor-not-allowed focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-400"
        >
          ← Prev
        </button>
        <button
          data-testid="diagram-step"
          onClick={handleNext}
          disabled={isLastStep}
          aria-label="Next diagram step"
          className="rounded-lg border border-sky-200 bg-white px-4 py-2 text-sm text-sky-600 hover:border-sky-400 hover:bg-sky-50 disabled:opacity-40 disabled:cursor-not-allowed focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-400"
        >
          Next →
        </button>
      </div>
    </div>
  );
}

// ── Shape renderer ────────────────────────────────────────────────────────────

const BASE_FILL = 'var(--color-sky-50, #f2f9ff)';
const BASE_STROKE = 'var(--color-sky-300, #8fcdfb)';
const HIGHLIGHT_FILL = 'var(--color-sun-300, #ffd98a)';
const HIGHLIGHT_STROKE = 'var(--color-sun-500, #f5b53f)';
const ARROW_COLOR = 'var(--color-sky-400, #54aef5)';
const ARROW_HIGHLIGHT = 'var(--color-sun-500, #f5b53f)';
const TEXT_COLOR = 'var(--color-ink-900, #1d2733)';
const TRANSITION_STYLE = 'fill 0.25s, stroke 0.25s';

type ShapeProps = {
  shape: DiagramShape;
  highlighted: boolean;
};

function ShapeRenderer({ shape, highlighted }: ShapeProps) {
  const fill = highlighted ? HIGHLIGHT_FILL : BASE_FILL;
  const stroke = highlighted ? HIGHLIGHT_STROKE : BASE_STROKE;

  switch (shape.kind) {
    case 'box': {
      const w = shape.w ?? 20;
      const h = shape.h ?? 12;
      return (
        <g>
          <rect
            x={shape.x}
            y={shape.y}
            width={w}
            height={h}
            rx={1.5}
            fill={fill}
            stroke={stroke}
            strokeWidth={0.6}
            style={{ transition: TRANSITION_STYLE }}
          />
          {shape.text && (
            <text
              x={shape.x + w / 2}
              y={shape.y + h / 2}
              textAnchor="middle"
              dominantBaseline="central"
              fontSize={3.5}
              fill={TEXT_COLOR}
            >
              {shape.text}
            </text>
          )}
        </g>
      );
    }
    case 'circle': {
      const r = Math.min(shape.w ?? 8, shape.h ?? 8) / 2;
      return (
        <g>
          <circle
            cx={shape.x}
            cy={shape.y}
            r={r}
            fill={fill}
            stroke={stroke}
            strokeWidth={0.6}
            style={{ transition: TRANSITION_STYLE }}
          />
          {shape.text && (
            <text
              x={shape.x}
              y={shape.y}
              textAnchor="middle"
              dominantBaseline="central"
              fontSize={3.5}
              fill={TEXT_COLOR}
            >
              {shape.text}
            </text>
          )}
        </g>
      );
    }
    case 'arrow': {
      if (shape.toX === undefined || shape.toY === undefined) return null;
      const arrowColor = highlighted ? ARROW_HIGHLIGHT : ARROW_COLOR;
      const markerId = `arrow-head-${shape.id}`;
      return (
        <g>
          <defs>
            <marker
              id={markerId}
              markerWidth="4"
              markerHeight="4"
              refX="3"
              refY="2"
              orient="auto"
            >
              <path d="M 0 0 L 4 2 L 0 4 z" fill={arrowColor} />
            </marker>
          </defs>
          <line
            x1={shape.x}
            y1={shape.y}
            x2={shape.toX}
            y2={shape.toY}
            stroke={arrowColor}
            strokeWidth={0.8}
            markerEnd={`url(#${markerId})`}
            style={{ transition: 'stroke 0.25s' }}
          />
          {shape.text && (
            <text
              x={(shape.x + shape.toX) / 2}
              y={(shape.y + shape.toY) / 2 - 1.5}
              textAnchor="middle"
              fontSize={3}
              fill={TEXT_COLOR}
            >
              {shape.text}
            </text>
          )}
        </g>
      );
    }
    case 'label': {
      if (!shape.text) return null;
      return (
        <text
          x={shape.x}
          y={shape.y}
          textAnchor="middle"
          dominantBaseline="central"
          fontSize={4}
          fill={highlighted ? ARROW_HIGHLIGHT : TEXT_COLOR}
          fontWeight={highlighted ? 'bold' : 'normal'}
          style={{ transition: 'fill 0.25s' }}
        >
          {shape.text}
        </text>
      );
    }
    default:
      return null;
  }
}
