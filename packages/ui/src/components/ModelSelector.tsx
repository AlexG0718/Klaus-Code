import { useState, useRef, useEffect } from 'react';
import type { ModelOption } from '../hooks/useAgentSocket';
import { MODEL_INFO } from '../hooks/useAgentSocket';

interface Props {
  label: string;
  selectedModel: ModelOption;
  onSelect: (model: ModelOption) => void;
  disabled?: boolean;
}

export function ModelSelector({ label, selectedModel, onSelect, disabled }: Props) {
  const [isOpen, setIsOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  // Close dropdown when clicking outside
  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const models: ModelOption[] = ['claude-sonnet-4-5', 'claude-opus-4-5'];
  const currentInfo = MODEL_INFO[selectedModel];

  // Cost indicator dots
  const costDots = (multiplier: number) => {
    const dots = multiplier >= 0.8 ? 3 : multiplier >= 0.15 ? 2 : 1;
    return (
      <span className="flex gap-0.5" title={`Relative cost: ${multiplier}x`}>
        {[1, 2, 3].map((i) => (
          <span
            key={i}
            className={`w-1.5 h-1.5 rounded-full ${
              i <= dots ? 'bg-yellow-400' : 'bg-gray-700'
            }`}
          />
        ))}
      </span>
    );
  };

  return (
    <div className="flex items-center gap-1.5">
      <span className="text-xs text-gray-500 font-medium uppercase tracking-wider">{label}</span>
    <div className="relative" ref={dropdownRef}>
      <button
        type="button"
        onClick={() => !disabled && setIsOpen(!isOpen)}
        disabled={disabled}
        className={`
          flex items-center gap-2 px-3 py-1.5 rounded-lg text-sm
          border border-gray-700 bg-gray-800/50
          ${disabled
            ? 'opacity-50 cursor-not-allowed'
            : 'hover:bg-gray-700/50 hover:border-gray-600 cursor-pointer'
          }
          transition-colors
        `}
        title={`${label} model: ${currentInfo.name} — ${currentInfo.description}`}
      >
        <span className="text-purple-400 font-medium">{currentInfo.name}</span>
        {costDots(currentInfo.costMultiplier)}
        <svg
          className={`w-4 h-4 text-gray-500 transition-transform ${isOpen ? 'rotate-180' : ''}`}
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {isOpen && (
        <div className="absolute top-full mt-2 left-0 w-52 bg-gray-800 border border-gray-700 rounded-lg shadow-xl z-50 overflow-hidden">
          <div className="px-3 py-2 border-b border-gray-700 text-xs text-gray-500">
            {label} model
          </div>
          {models.map((model) => {
            const info = MODEL_INFO[model];
            const isSelected = model === selectedModel;
            return (
              <button
                type="button"
                key={model}
                onClick={() => {
                  onSelect(model);
                  setIsOpen(false);
                }}
                className={`
                  w-full px-3 py-2.5 flex items-center justify-between text-left
                  ${isSelected ? 'bg-purple-900/30' : 'hover:bg-gray-700/50'}
                  transition-colors
                `}
              >
                <div className="flex flex-col">
                  <span className={`font-medium ${isSelected ? 'text-purple-400' : 'text-gray-200'}`}>
                    {info.name}
                  </span>
                  <span className="text-xs text-gray-500">{info.description}</span>
                </div>
                <div className="flex items-center gap-2">
                  {costDots(info.costMultiplier)}
                  {isSelected && (
                    <svg className="w-4 h-4 text-purple-400" fill="currentColor" viewBox="0 0 20 20">
                      <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
                    </svg>
                  )}
                </div>
              </button>
            );
          })}
        </div>
      )}
    </div>
    </div>
  );
}
