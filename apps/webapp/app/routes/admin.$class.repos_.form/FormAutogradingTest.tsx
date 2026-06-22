import { Input, InputNumber, Select } from 'antd';
import type { ReactNode } from 'react';

export interface AutogradingTestData {
  id?: string | null;
  name: string;
  method: 'COMMAND' | 'IO' | 'PYTHON' | 'JAVA' | 'NODE' | 'C' | 'CPP';
  setup_command?: string;
  run_command?: string;
  input?: string;
  expected_output?: string;
  comparison_method?: 'INCLUDED' | 'EXACT' | 'REGEX';
  timeout?: number;
}

export const emptyAutogradingTest = (): AutogradingTestData => ({
  id: null,
  name: '',
  method: 'COMMAND',
  setup_command: '',
  run_command: '',
  input: '',
  expected_output: '',
  comparison_method: 'INCLUDED',
  timeout: 10,
});

const METHOD_OPTIONS = [
  { value: 'COMMAND', label: 'Run command' },
  { value: 'IO', label: 'Input / output' },
  { value: 'PYTHON', label: 'Python' },
  { value: 'JAVA', label: 'Java' },
  { value: 'NODE', label: 'Node' },
  { value: 'C', label: 'C' },
  { value: 'CPP', label: 'C++' },
];

// Language presets prefill the commands (pure UI sugar). All except IO still
// compile to the command grader; the backend treats them identically.
const PRESET_DEFAULTS: Record<string, { setup_command?: string; run_command?: string }> = {
  NODE: { setup_command: 'npm install', run_command: 'npm test' },
  PYTHON: { setup_command: 'pip install -r requirements.txt', run_command: 'pytest' },
  JAVA: { setup_command: '', run_command: 'mvn test' },
  C: { setup_command: '', run_command: 'gcc *.c -o a.out && ./a.out' },
  CPP: { setup_command: '', run_command: 'g++ *.cpp -o a.out && ./a.out' },
};

const Field = ({
  label,
  required,
  hint,
  children,
}: {
  label: string;
  required?: boolean;
  hint?: string;
  children: ReactNode;
}) => (
  <div>
    <label className="block text-sm font-medium text-ink-1 mb-1">
      {label}
      {required && <span className="text-red-500"> *</span>}
    </label>
    {children}
    {hint && <p className="text-xs text-ink-4 mt-1">{hint}</p>}
  </div>
);

interface FormAutogradingTestProps {
  value: AutogradingTestData;
  onChange: (next: AutogradingTestData) => void;
}

const FormAutogradingTest = ({ value, onChange }: FormAutogradingTestProps) => {
  const set = (patch: Partial<AutogradingTestData>) => onChange({ ...value, ...patch });

  const onMethodChange = (method: AutogradingTestData['method']) => {
    const preset = PRESET_DEFAULTS[method];
    // Prefill commands for language presets, like GitHub Classroom.
    set({ method, ...(preset ?? {}) });
  };

  const isIO = value.method === 'IO';

  return (
    <div className="flex flex-col gap-4">
      <Field label="Test name" required>
        <Input
          value={value.name}
          onChange={e => set({ name: e.target.value })}
          placeholder="Hello world test"
        />
      </Field>

      <Field label="Method">
        <Select
          value={value.method}
          onChange={onMethodChange}
          options={METHOD_OPTIONS}
          className="w-full"
        />
      </Field>

      {!isIO && (
        <Field label="Setup command" hint="Optional. Runs before the test (e.g. npm install).">
          <Input
            value={value.setup_command}
            onChange={e => set({ setup_command: e.target.value })}
            placeholder="npm install"
          />
        </Field>
      )}

      <Field
        label="Run command"
        required
        hint={
          isIO
            ? 'The program to run; its stdout is compared to the expected output.'
            : 'Passes if it exits with code 0.'
        }
      >
        <Input
          value={value.run_command}
          onChange={e => set({ run_command: e.target.value })}
          placeholder={isIO ? './program' : 'npm test'}
        />
      </Field>

      {isIO && (
        <>
          <Field label="Input" hint="Passed to the program's stdin.">
            <Input.TextArea
              value={value.input}
              onChange={e => set({ input: e.target.value })}
              rows={2}
              placeholder="1 + 1"
            />
          </Field>
          <Field label="Expected output" required>
            <Input.TextArea
              value={value.expected_output}
              onChange={e => set({ expected_output: e.target.value })}
              rows={2}
              placeholder="2"
            />
          </Field>
          <Field label="Comparison method">
            <Select
              value={value.comparison_method}
              onChange={v => set({ comparison_method: v })}
              className="w-full"
              options={[
                { value: 'INCLUDED', label: 'Included' },
                { value: 'EXACT', label: 'Exact' },
                { value: 'REGEX', label: 'Regex' },
              ]}
            />
          </Field>
        </>
      )}

      <Field label="Timeout (minutes)" hint="Max 60. The test is killed if it runs longer.">
        <InputNumber
          min={1}
          max={60}
          value={value.timeout}
          onChange={v => set({ timeout: v ?? 10 })}
          className="w-full"
        />
      </Field>

      <p className="text-xs text-ink-4">
        Grading isn&apos;t wired up yet — tests run on each push and report pass/fail only.
      </p>
    </div>
  );
};

export default FormAutogradingTest;
