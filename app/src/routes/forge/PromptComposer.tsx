import { useState } from "react";
import type { Skill } from "./types.js";

type PromptComposerProps = {
  extraPrompt: string;
  onExtraPromptChange: (v: string) => void;
  skills: Skill[];
};

export function PromptComposer({ extraPrompt, onExtraPromptChange, skills }: PromptComposerProps) {
  const [autocompleteOpen, setAutocompleteOpen] = useState(false);
  const [autocompleteFilter, setAutocompleteFilter] = useState("");
  const [autocompleteCursor, setAutocompleteCursor] = useState(0);

  const filteredSkills = skills.filter(s => s.name.toLowerCase().includes(autocompleteFilter));

  const handlePromptChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const val = e.target.value;
    onExtraPromptChange(val);
    
    const cursor = e.target.selectionStart;
    const textBeforeCursor = val.slice(0, cursor);
    const words = textBeforeCursor.split(/\s+/);
    const lastWord = words[words.length - 1];
    
    if (lastWord.startsWith("/")) {
      setAutocompleteFilter(lastWord.slice(1).toLowerCase());
      setAutocompleteCursor(cursor);
      setAutocompleteOpen(true);
    } else {
      setAutocompleteOpen(false);
    }
  };

  const insertSkill = (skillName: string) => {
    const textBeforeCursor = extraPrompt.slice(0, autocompleteCursor);
    const textAfterCursor = extraPrompt.slice(autocompleteCursor);
    const lastSlashIndex = textBeforeCursor.lastIndexOf("/");
    const newText = textBeforeCursor.slice(0, lastSlashIndex) + "/" + skillName + " " + textAfterCursor;
    onExtraPromptChange(newText);
    setAutocompleteOpen(false);
  };

  return (
    <div className="flex flex-col gap-1 relative">
      <label className="text-xs font-code-sm text-on-surface-variant uppercase">Operator Prompt</label>
      <textarea
        className="bg-surface-container/50 border border-white/10 rounded px-3 py-2 text-sm text-on-surface outline-none min-h-[80px] resize-y"
        placeholder="Extra instructions for this run (optional). Type / for skills."
        value={extraPrompt}
        onChange={handlePromptChange}
        onKeyDown={e => {
          if (e.key === "Escape") setAutocompleteOpen(false);
        }}
      />
      {autocompleteOpen && filteredSkills.length > 0 && (
        <ul className="absolute bottom-full left-0 mb-1 w-64 max-h-48 overflow-y-auto bg-surface-container-highest border border-white/10 rounded shadow-lg z-10">
          {filteredSkills.map(s => (
            <li
              key={s.name}
              onClick={() => insertSkill(s.name)}
              className="px-3 py-2 text-sm hover:bg-primary/20 hover:text-primary cursor-pointer text-on-surface transition-colors"
            >
              /{s.name}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
