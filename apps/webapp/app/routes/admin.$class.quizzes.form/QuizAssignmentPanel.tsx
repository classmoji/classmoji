import { Button, DatePicker, Form, InputNumber, Select, Switch } from 'antd';
import dayjs, { type Dayjs } from 'dayjs';
import { Link } from 'react-router';

/**
 * The quiz form's Assignment panel (boards I1 and I3): where the quiz sits in
 * the course and when students see it. Its fields live in the quiz form under
 * `assignment.*` and post with the quiz as one save.
 *
 * The owner and teachers edit it; a teaching assistant sees it read-only and
 * no assignment field enters the form (an assistant's save carries content
 * only). A quiz cannot be saved without a module.
 */

export interface ModuleOption {
  id: string;
  title: string;
}

/** The panel's values as the loader sends them (dates as ISO strings). */
export interface AssignmentPanelData {
  moduleId: string | null;
  moduleTitle: string | null;
  releaseAt: string | null;
  dueDate: string | null;
  closesAt: string | null;
  weight: number;
  /** The quiz's own price per extension hour; null = the classroom's rate, 0 = no extensions. */
  tokensPerHour: number | null;
  isPublished: boolean;
}

/** The panel's values inside the form. */
export interface AssignmentPanelValues {
  moduleId?: string;
  releaseAt?: Dayjs | null;
  dueDate?: Dayjs | null;
  closesAt?: Dayjs | null;
  weight?: number | null;
  tokensPerHour?: number | null;
  isPublished?: boolean;
}

const DATE_FORMAT = 'ddd MMM D, YYYY · h:mm A';
/** The short date a pill or a confirm names. */
export const SHORT_DATE_FORMAT = 'ddd MMM D · h:mm A';

const toDayjs = (iso: string | null) => (iso ? dayjs(iso) : null);

/** The loader's values, as the form holds them. */
export const panelFormValues = (data: AssignmentPanelData): AssignmentPanelValues => ({
  moduleId: data.moduleId ?? undefined,
  releaseAt: toDayjs(data.releaseAt),
  dueDate: toDayjs(data.dueDate),
  closesAt: toDayjs(data.closesAt),
  weight: data.weight,
  tokensPerHour: data.tokensPerHour,
  isPublished: data.isPublished,
});

export type AssignmentPanelPayload = {
  moduleId: string | null;
  releaseAt: string | null;
  dueDate: string | null;
  closesAt: string | null;
  weight: number;
  /** Null = the classroom's rate. */
  tokensPerHour: number | null;
  isPublished: boolean;
};

/** An emptied price field is the classroom's rate (null); a number is the quiz's own. */
const priceOf = (value: number | string | null | undefined) =>
  value === null || value === undefined || value === '' ? null : Number(value);

/** The form's values, as the quiz action takes them. */
export const panelPayload = (
  values: AssignmentPanelValues | undefined
): AssignmentPanelPayload => ({
  moduleId: values?.moduleId ?? null,
  releaseAt: values?.releaseAt ? values.releaseAt.toISOString() : null,
  dueDate: values?.dueDate ? values.dueDate.toISOString() : null,
  closesAt: values?.closesAt ? values.closesAt.toISOString() : null,
  weight: Number(values?.weight ?? 0),
  tokensPerHour: priceOf(values?.tokensPerHour),
  isPublished: values?.isPublished === true,
});

const sameInstant = (a: string | null, b: string | null) =>
  a === b || (a !== null && b !== null && new Date(a).getTime() === new Date(b).getTime());

/**
 * Only the panel fields that differ from what the loader showed, for a save
 * of an existing quiz. A form opened before someone else published the quiz,
 * or moved its due date, then sends nothing it did not change and cannot put
 * the old values back. Empty when nothing changed.
 */
export const changedPanelPayload = (
  values: AssignmentPanelValues | undefined,
  initial: AssignmentPanelData
): Partial<AssignmentPanelPayload> => {
  const now = panelPayload(values);
  const changed: Partial<AssignmentPanelPayload> = {};
  if (now.moduleId !== initial.moduleId) changed.moduleId = now.moduleId;
  if (!sameInstant(now.releaseAt, initial.releaseAt)) changed.releaseAt = now.releaseAt;
  if (!sameInstant(now.dueDate, initial.dueDate)) changed.dueDate = now.dueDate;
  if (!sameInstant(now.closesAt, initial.closesAt)) changed.closesAt = now.closesAt;
  if (now.weight !== initial.weight) changed.weight = now.weight;
  // Empty (the classroom's rate) and 0 (no extensions) differ.
  if (now.tokensPerHour !== initial.tokensPerHour) changed.tokensPerHour = now.tokensPerHour;
  if (now.isPublished !== initial.isPublished) changed.isPublished = now.isPublished;
  return changed;
};

/** Whether Opens, Due or Closes differ from what the loader showed. */
export const panelDatesChanged = (
  values: Pick<AssignmentPanelValues, 'releaseAt' | 'dueDate' | 'closesAt'>,
  initial: AssignmentPanelData
) => {
  const changed = changedPanelPayload(values, initial);
  return 'releaseAt' in changed || 'dueDate' in changed || 'closesAt' in changed;
};

type DateValue = Dayjs | string | null | undefined;

const asDayjs = (value: DateValue) =>
  value == null ? null : typeof value === 'string' ? dayjs(value) : value;

/** Whether an Opens date is still ahead: the quiz is published but not open yet. */
export const opensLater = (releaseAt: DateValue, now: Dayjs = dayjs()) => {
  const opens = asDayjs(releaseAt);
  return Boolean(opens && opens.isAfter(now));
};

/**
 * What is wrong with the Closes date, or null: it may not come before Opens
 * (no attempt could start at all). Closing before Due is allowed: a quiz can
 * be closed early.
 */
export const closesDateError = ({
  releaseAt,
  closesAt,
}: {
  releaseAt: DateValue;
  closesAt: DateValue;
}): string | null => {
  const closes = asDayjs(closesAt);
  const opens = asDayjs(releaseAt);
  if (closes && opens && closes.isBefore(opens)) return 'Closes can’t be before Opens';
  return null;
};

/**
 * Where students see the quiz, read off the panel: nowhere until it is
 * published and open; then the Assignments page, its module, the calendar
 * when it has a due date, the dashboard, and grades when its weight counts.
 */
export const studentsSeeItIn = ({
  isPublished,
  moduleTitle,
  hasDueDate,
  weight,
  releaseAt = null,
  now = dayjs(),
}: {
  isPublished: boolean;
  moduleTitle: string | null;
  hasDueDate: boolean;
  weight: number;
  releaseAt?: DateValue;
  now?: Dayjs;
}): string[] => {
  if (!isPublished || opensLater(releaseAt, now)) return [];
  return [
    'Assignments',
    ...(moduleTitle ? [moduleTitle] : []),
    ...(hasDueDate ? ['Calendar'] : []),
    'Dashboard',
    ...(weight > 0 ? ['Grades'] : []),
  ];
};

/**
 * Draft / Scheduled (with the Opens date) / Published / Closed, as the
 * panel's header pill shows it.
 */
export const panelStatus = (
  isPublished: boolean,
  closesAt: DateValue,
  releaseAt: DateValue = null,
  now: Dayjs = dayjs()
) => {
  if (!isPublished) return 'Draft';
  if (opensLater(releaseAt, now)) {
    return `Scheduled · ${asDayjs(releaseAt)!.format(SHORT_DATE_FORMAT)}`;
  }
  const closes = asDayjs(closesAt);
  return closes && !closes.isAfter(now) ? 'Closed' : 'Published';
};

const StatusPill = ({ status }: { status: string }) =>
  status === 'Published' ? (
    <span
      className="inline-flex items-center gap-2 text-[13px] font-semibold text-green-700 dark:text-green-400"
      data-testid="quiz-assignment-status"
    >
      <span className="h-2 w-2 rounded-full bg-green-600 dark:bg-green-400" />
      Published
    </span>
  ) : (
    <span
      className="rounded-md border border-stone-200 bg-stone-100 px-2.5 py-0.5 text-xs font-semibold text-gray-600 dark:border-neutral-700 dark:bg-neutral-800 dark:text-gray-300"
      data-testid="quiz-assignment-status"
    >
      {status}
    </span>
  );

const Chips = ({ places }: { places: string[] }) =>
  places.length === 0 ? null : (
    <div className="flex flex-col gap-2 border-t border-stone-200 pt-3 dark:border-neutral-800">
      <span className="text-xs font-bold tracking-widest text-gray-500 dark:text-gray-400">
        STUDENTS SEE IT IN
      </span>
      <div className="flex flex-wrap gap-1.5" data-testid="quiz-students-see-it-in">
        {places.map(place => (
          <span
            key={place}
            className="rounded-md border border-stone-200 bg-stone-100 px-2.5 py-1 text-xs font-semibold text-gray-600 dark:border-neutral-700 dark:bg-neutral-800 dark:text-gray-300"
          >
            {place}
          </span>
        ))}
      </div>
    </div>
  );

/**
 * How the price reads: the quiz's own, none, or the classroom's rate (with its
 * value). Empty at a classroom rate of 0 sells no hours either.
 */
export const tokensPerHourLabel = (tokensPerHour: number | null, classroomTokensPerHour: number) =>
  tokensPerHour === null
    ? classroomTokensPerHour > 0
      ? `Classroom rate (${classroomTokensPerHour})`
      : 'No extensions'
    : tokensPerHour === 0
      ? 'No extensions'
      : String(tokensPerHour);

const PANEL_CLASS =
  'rounded-2xl bg-white dark:bg-neutral-900 ring-1 ring-stone-200 dark:ring-neutral-800 p-5 flex flex-col gap-3';

/** The panel for the owner and teachers: every field editable. */
export const EditableAssignmentPanel = ({
  modules,
  isOwner,
  classSlug,
  classroomTokensPerHour,
  closesError = null,
}: {
  modules: ModuleOption[];
  isOwner: boolean;
  classSlug: string;
  /** The classroom's price per extension hour, which an empty field means. */
  classroomTokensPerHour: number;
  /** What is wrong with Closes (closesDateError), shown under the field. */
  closesError?: string | null;
}) => {
  const form = Form.useFormInstance();
  const moduleId = Form.useWatch(['assignment', 'moduleId'], form) as string | undefined;
  const isPublished = Form.useWatch(['assignment', 'isPublished'], form) === true;
  const releaseAt = Form.useWatch(['assignment', 'releaseAt'], form) as Dayjs | null | undefined;
  const dueDate = Form.useWatch(['assignment', 'dueDate'], form) as Dayjs | null | undefined;
  const closesAt = Form.useWatch(['assignment', 'closesAt'], form) as Dayjs | null | undefined;
  const weight = Number(Form.useWatch(['assignment', 'weight'], form) ?? 0);
  const tokensPerHour = priceOf(
    Form.useWatch(['assignment', 'tokensPerHour'], form) as number | null | undefined
  );
  const moduleTitle = modules.find(m => m.id === moduleId)?.title ?? null;

  return (
    <section className={PANEL_CLASS} data-testid="quiz-assignment-panel">
      <div className="flex items-center justify-between">
        <h2 className="m-0 text-[15px] font-semibold text-gray-900 dark:text-gray-100">
          Assignment
        </h2>
        <StatusPill status={panelStatus(isPublished, closesAt, releaseAt)} />
      </div>

      {modules.length === 0 ? (
        <div
          className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2.5 text-sm text-amber-900 dark:border-amber-800/50 dark:bg-amber-900/20 dark:text-amber-200"
          data-testid="quiz-no-modules-note"
        >
          {isOwner ? (
            <>
              A quiz lives in a module.{' '}
              <Link
                to={`/admin/${classSlug}/modules`}
                target="_blank"
                rel="noreferrer"
                className="font-semibold text-blue-700 underline underline-offset-2 hover:text-blue-800 dark:text-blue-300 dark:hover:text-blue-200"
                data-testid="quiz-add-module-link"
              >
                Add a module
              </Link>{' '}
              first.
            </>
          ) : (
            'A quiz lives in a module. The class owner has to add a module before a quiz can be saved.'
          )}
        </div>
      ) : (
        <Form.Item
          name={['assignment', 'moduleId']}
          label="Module"
          required
          className="mb-0"
          validateStatus={moduleId ? undefined : 'error'}
          help={moduleId ? undefined : 'Choose a module'}
        >
          <Select
            showSearch
            optionFilterProp="label"
            placeholder="Choose a module"
            options={modules.map(m => ({ value: m.id, label: m.title }))}
            data-testid="quiz-module-select"
          />
        </Form.Item>
      )}

      <Form.Item name={['assignment', 'releaseAt']} label="Opens" className="mb-0">
        <DatePicker showTime format={DATE_FORMAT} placeholder="When published" className="w-full" />
      </Form.Item>

      <Form.Item name={['assignment', 'dueDate']} label="Due" className="mb-0">
        <DatePicker showTime format={DATE_FORMAT} placeholder="No due date" className="w-full" />
      </Form.Item>

      <Form.Item
        label="Closes"
        className="mb-0"
        validateStatus={closesError ? 'error' : undefined}
        help={closesError ?? undefined}
      >
        <div className="flex gap-2">
          <Form.Item name={['assignment', 'closesAt']} noStyle>
            <DatePicker
              showTime
              format={DATE_FORMAT}
              placeholder="Never"
              className="min-w-0 flex-1"
              status={closesError ? 'error' : undefined}
              data-testid="quiz-closes-at"
            />
          </Form.Item>
          <Button
            onClick={() => form.setFieldValue(['assignment', 'closesAt'], dayjs())}
            data-testid="quiz-close-now"
          >
            Close now
          </Button>
        </div>
      </Form.Item>

      <Form.Item name={['assignment', 'weight']} label="Weight" className="mb-0">
        <InputNumber min={0} className="w-full" />
      </Form.Item>

      <Form.Item
        name={['assignment', 'tokensPerHour']}
        label="Tokens per hour"
        className="mb-0"
        help={tokensPerHour === 0 ? 'No extensions' : undefined}
      >
        <InputNumber
          min={0}
          precision={0}
          className="w-full"
          placeholder={tokensPerHourLabel(null, classroomTokensPerHour)}
          data-testid="quiz-tokens-per-hour"
        />
      </Form.Item>

      <div className="flex items-center justify-between border-t border-stone-200 pt-3 dark:border-neutral-800">
        <span className="text-sm font-semibold text-gray-900 dark:text-gray-100">Published</span>
        <Form.Item name={['assignment', 'isPublished']} valuePropName="checked" noStyle>
          <Switch aria-label="Published" data-testid="quiz-published-switch" />
        </Form.Item>
      </div>

      <Chips
        places={studentsSeeItIn({
          isPublished,
          moduleTitle,
          hasDueDate: Boolean(dueDate),
          weight,
          releaseAt,
        })}
      />
    </section>
  );
};

const formatDate = (iso: string | null, empty: string) =>
  iso ? dayjs(iso).format(DATE_FORMAT) : empty;

/** The panel for a teaching assistant: what is set, nothing editable. */
export const ReadOnlyAssignmentPanel = ({
  data,
  classroomTokensPerHour,
}: {
  data: AssignmentPanelData;
  classroomTokensPerHour: number;
}) => {
  const rows: Array<[string, string]> = [
    ['Module', data.moduleTitle ?? 'None'],
    ['Opens', formatDate(data.releaseAt, 'When published')],
    ['Due', formatDate(data.dueDate, 'No due date')],
    ['Closes', formatDate(data.closesAt, 'Never')],
    ['Weight', `${data.weight}%`],
    ['Tokens per hour', tokensPerHourLabel(data.tokensPerHour, classroomTokensPerHour)],
    ['Published', data.isPublished ? 'Yes' : 'No'],
  ];
  return (
    <section className={PANEL_CLASS} data-testid="quiz-assignment-panel-readonly">
      <div className="flex items-center justify-between">
        <h2 className="m-0 text-[15px] font-semibold text-gray-900 dark:text-gray-100">
          Assignment
        </h2>
        <StatusPill status={panelStatus(data.isPublished, data.closesAt, data.releaseAt)} />
      </div>
      {!data.moduleId && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2.5 text-sm text-amber-900 dark:border-amber-800/50 dark:bg-amber-900/20 dark:text-amber-200">
          The class owner or a teacher chooses this quiz's module.
        </div>
      )}
      <dl className="m-0 grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
        {rows.map(([label, value]) => (
          <div key={label} className="contents">
            <dt className="font-semibold text-gray-500 dark:text-gray-400">{label}</dt>
            <dd className="m-0 text-gray-900 dark:text-gray-100">{value}</dd>
          </div>
        ))}
      </dl>
      <Chips
        places={studentsSeeItIn({
          isPublished: data.isPublished,
          moduleTitle: data.moduleTitle,
          hasDueDate: Boolean(data.dueDate),
          weight: data.weight,
          releaseAt: data.releaseAt,
        })}
      />
    </section>
  );
};
