import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  ExForm,
  FormErrorSummary,
  Input,
  Textarea,
  useForm,
  type FormInstance,
  type FormValues,
  type FormPath,
  type FormFieldConfig,
  type FormStep,
  type FormRenderArguments,
  type FormSnapshot,
} from "@exre/exui";
import { X } from "lucide-react";
import { SelectOrOther } from "@components/src/join/SelectOrOther";
import {
  experiencedJoinApplicationSchema,
  newJoinApplicationSchema,
  newApplicationStepSchemas,
  experiencedApplicationStepSchemas,
  type JoinApplicationDraft,
  type JoinApplicationType,
  type NewJoinApplicationInput,
  type ExperiencedJoinApplicationInput,
} from "@components/src/join/applicationSchemas";
import {
  joinApplicationCommitments,
  joinApplicationFields,
  joinApplicationSteps,
} from "@components/src/join/applicationFields";
import { ProofFileInput } from "@components/src/join/ProofFileInput";
import styles from "@components/src/join/CompleteJoinApplication.module.scss";

export interface CompleteJoinApplicationModalHandle {
  setError: (message: string, field?: "qq") => void;
  getDraft: () =>
    | FormSnapshot<NewJoinApplicationInput | ExperiencedJoinApplicationInput>
    | undefined;
}
interface InternalHandle extends CompleteJoinApplicationModalHandle {
  isSubmitting: () => boolean;
}
export interface CompleteJoinApplicationModalProps {
  open: boolean;
  account?: { email: string; nickname: string };
  submitDisabled?: boolean;
  applicationType: JoinApplicationType;
  step: number;
  busy: boolean;
  initialDraft?: FormSnapshot<
    NewJoinApplicationInput | ExperiencedJoinApplicationInput
  >;
  onStepChange: (step: number) => void;
  onOpenChange: (open: boolean) => void;
  onSubmit: (draft: JoinApplicationDraft) => Promise<void>;
  onCloseAutoFocus?: (event: Event) => void;
  serverAction?: ReactNode;
  resultTitle?: string;
  children?: ReactNode;
}
type FormProps = Omit<
  CompleteJoinApplicationModalProps,
  "open" | "onCloseAutoFocus" | "children"
> & { handleRef: React.Ref<InternalHandle> };
function atPath(value: unknown, path: string): unknown {
  return path
    .split(".")
    .reduce<unknown>(
      (current, key) =>
        current && typeof current === "object"
          ? (current as Record<string, unknown>)[key]
          : undefined,
      value,
    );
}
function FormSummary<T extends FormValues, O extends JoinApplicationDraft>({
  form,
  type,
}: {
  form: FormInstance<T, O>;
  type: JoinApplicationType;
}) {
  const values = form.getValues();
  const fields = joinApplicationFields(type);
  const steps = joinApplicationSteps(type);
  const proofs = atPath(values, "proofs") as readonly File[];
  return (
    <div className={styles.summary}>
      {steps.slice(0, -1).map((step, index) => (
        <section key={step} aria-label={`${step}摘要`}>
          <h3>{step}</h3>
          <dl>
            {fields
              .filter((field) => field.step === index)
              .map((field) => {
                const raw = atPath(values, field.name);
                const selected = Array.isArray(raw)
                  ? raw
                      .map(
                        (value) =>
                          field.options?.find(
                            (option) => option.value === value,
                          )?.label ?? String(value),
                      )
                      .join("、")
                  : (field.options?.find((option) => option.value === raw)
                      ?.label ?? (typeof raw === "string" ? raw.trim() : ""));
                return (
                  <div key={field.name}>
                    <dt>{field.label}</dt>
                    <dd>
                      {field.name === "email"
                        ? selected.toLowerCase()
                        : selected || "未填写"}
                    </dd>
                  </div>
                );
              })}
            {type === "experienced" && index === 3 && (
              <div>
                <dt>证明文件</dt>
                <dd>
                  {proofs.length === 0 ? (
                    "无"
                  ) : (
                    <ul>
                      {proofs.map((file, position) => (
                        <li key={position}>
                          {file.name}（{(file.size / (1024 * 1024)).toFixed(2)}{" "}
                          MiB）
                        </li>
                      ))}
                    </ul>
                  )}
                </dd>
              </div>
            )}
          </dl>
        </section>
      ))}
    </div>
  );
}

const stepHints = {
  new: [
    "留下常用联系方式，方便接收审核结果。",
    "补充基本资料，并选择你希望申请的部门。",
    "谈谈你对角色扮演和紧急职业模拟的理解。",
    "最后补充你的空闲安排和了解我们的渠道。",
    "请核对全部资料和证明文件，并阅读、确认申请承诺。提交后资料不可修改，每个账号在每个社区终身只能申请一次。",
  ],
  experienced: [
    "留下常用联系方式，方便接收审核结果。",
    "补充基本资料，并选择你希望申请的部门。",
    "介绍一下你过去的服务器与任职经历。",
    "完成以下问答，如有证明材料也可以一并补充。",
    "最后补充你的空闲安排和了解我们的渠道。",
    "请核对全部资料和证明文件，并阅读、确认申请承诺。提交后资料不可修改，每个账号在每个社区终身只能申请一次。",
  ],
};
function Wizard<T extends FormValues, O extends JoinApplicationDraft>({
  form,
  props,
}: {
  form: FormInstance<T, O>;
  props: FormProps;
}) {
  const {
    applicationType,
    step,
    busy,
    onStepChange,
    onSubmit,
    onOpenChange,
    serverAction,
    handleRef,
  } = props;
  const titles = joinApplicationSteps(applicationType);
  const last = titles.length - 1;
  const disabled = busy || form.state.isSubmitting;
  const body = useRef<HTMLElement>(null);
  const pendingFocus = useRef<FormPath<T> | null>(null);
  const [footerHost, setFooterHost] = useState<HTMLDivElement | null>(null);
  useImperativeHandle(handleRef, () => ({
    getDraft: () =>
      form.getValues() as unknown as FormSnapshot<
        NewJoinApplicationInput | ExperiencedJoinApplicationInput
      >,
    isSubmitting: () => busy || form.state.isSubmitting,
    setError: (message, field) => {
      form.setError(field ? (field as FormPath<T>) : "root.server", {
        message,
      });
      if (field) {
        pendingFocus.current = field as FormPath<T>;
        onStepChange(0);
      }
    },
  }));
  useEffect(() => {
    if (body.current) body.current.scrollTop = 0;
  }, [step]);
  useEffect(() => {
    if (!pendingFocus.current) return;
    // ExForm commits its controlled step after our render. Focus on the next
    // frame, when that step's real input has registered with the form instance.
    const frame = requestAnimationFrame(() => {
      if (pendingFocus.current) form.setFocus(pendingFocus.current);
      pendingFocus.current = null;
    });
    return () => cancelAnimationFrame(frame);
  }, [step, form, form.state.errors]);
  const fields = useMemo(() => {
    const configured = joinApplicationFields(applicationType).map(
      (definition) => {
        const base = {
          name: definition.name,
          label: definition.label,
          description: definition.description,
          preserve: true,
        };
        if (definition.kind === "select")
          return {
            ...base,
            control: "select",
            controlProps: {
              options: definition.options,
              placeholder: "请选择",
            },
          };
        if (definition.kind === "choices")
          return {
            ...base,
            control: "checkbox-group",
            controlProps: { options: definition.options },
          };
        if (definition.kind === "date")
          return {
            ...base,
            control: "date",
            controlProps: { min: "1990-01-01", max: "2016-01-01" },
          };
        return {
          ...base,
          render: ({
            field,
            state,
            accessibility,
          }: FormRenderArguments<T, FormPath<T>>) => {
            const value = typeof field.value === "string" ? field.value : "";
            const onChange = (next: string) => field.onChange(next as never);
            const Control = definition.kind === "textarea" ? Textarea : Input;
            return (
              <>
                {definition.presets ? (
                  <SelectOrOther
                    value={value}
                    options={definition.presets}
                    label={definition.label}
                    multiline={definition.kind === "textarea"}
                    disabled={state.disabled}
                    accessibility={accessibility}
                    onChange={onChange}
                    onBlur={field.onBlur}
                    inputRef={field.ref}
                  />
                ) : (
                  <Control
                    {...accessibility}
                    ref={field.ref}
                    disabled={state.disabled}
                    value={value}
                    type={
                      definition.kind === "textarea"
                        ? undefined
                        : (definition.kind ?? "text")
                    }
                    autoComplete={definition.autoComplete}
                    inputMode={definition.inputMode}
                    onBlur={field.onBlur}
                    onChange={(event) => onChange(event.target.value)}
                  />
                )}
              </>
            );
          },
        };
      },
    );
    // This is the adapter from the existing string-path field catalogue to ExForm.
    // Schemas remain the authority for the value at each path.
    const result = configured as unknown as FormFieldConfig<T>[];
    if (applicationType === "experienced")
      result.push({
        name: "proofs",
        label: "证明文件（可选）",
        preserve: true,
        description:
          "支持图片、PDF、Office 文档、文本和压缩包。文件仅供审核下载，不在页面内预览。",
        render: ({
          field,
          state,
          accessibility,
        }: FormRenderArguments<T, FormPath<T>>) => (
          <ProofFileInput
            files={field.value as readonly File[]}
            disabled={state.disabled}
            accessibility={accessibility}
            inputRef={field.ref}
            onBlur={field.onBlur}
            onChange={(files) => {
              field.onChange(files as never);
              form.clearErrors("proofs" as FormPath<T>);
            }}
            onError={(message) =>
              form.setError("proofs" as FormPath<T>, { message })
            }
          />
        ),
      } as unknown as FormFieldConfig<T>);
    for (const commitment of joinApplicationCommitments(applicationType))
      result.push({
        name: commitment.name,
        label: commitment.label,
        control: "checkbox",
        className: styles.commitment,
        preserve: true,
      } as unknown as FormFieldConfig<T>);
    return result;
  }, [applicationType, form]);
  const steps = useMemo(() => {
    const schemas =
      applicationType === "new"
        ? newApplicationStepSchemas
        : experiencedApplicationStepSchemas;
    const definitions = joinApplicationFields(applicationType);
    return titles.map((title, index) => ({
      id: `step-${index}`,
      title,
      fields: (index === last
        ? joinApplicationCommitments(applicationType).map((entry) => entry.name)
        : [
            ...definitions
              .filter((entry) => entry.step === index)
              .map((entry) => entry.name),
            ...(applicationType === "experienced" && index === 3
              ? ["proofs"]
              : []),
          ]) as FormPath<T>[],
      validationSchema: schemas[index]!,
    })) satisfies FormStep<T>[];
  }, [applicationType, last]);
  return (
    <>
      <DialogHeader className={styles.header}>
        <DialogTitle className={styles.title}>
          {applicationType === "new" ? "新玩家申请" : "调转申请"}
        </DialogTitle>
        <Button
          className={styles.close}
          type="button"
          variant="ghost"
          size="icon"
          aria-label="关闭申请"
          disabled={disabled}
          onClick={() => onOpenChange(false)}
        >
          <X size={18} aria-hidden="true" />
        </Button>
      </DialogHeader>
      <section
        ref={body}
        className={styles.body}
        aria-label={`${titles[step]}内容`}
      >
        <p className={styles.hint} aria-live="polite">
          {stepHints[applicationType][step]}
        </p>
        {props.account && <dl aria-label="当前申请账号"><dt>账户邮箱</dt><dd>{props.account.email}</dd><dt>账户名字</dt><dd>{props.account.nickname}</dd></dl>}
        {step === last && <FormSummary form={form} type={applicationType} />}
        {serverAction && (
          <div className={styles.serverAction}>{serverAction}</div>
        )}
        <ExForm
          form={form}
          fields={fields}
          steps={steps}
          currentStep={`step-${step}`}
          onStepChange={(id) => onStepChange(Number(id.slice(5)))}
          className={styles.form}
          disabled={busy}
          submitErrorMessage="提交失败，请稍后重试。已填写的资料与文件会保留。"
          onSubmit={async (draft) => {
            form.clearErrors("root.server");
            await onSubmit(draft);
          }}
          footer={(args) =>
            footerHost &&
            createPortal(
              <div className={styles.navigation}>
                {!args.isFirstStep && (
                  <Button
                    type="button"
                    variant="outline"
                    disabled={disabled || args.state.isValidating}
                    onClick={args.back}
                  >
                    {args.isLastStep ? "返回修改" : "上一步"}
                  </Button>
                )}
                <Button
                  type="button"
                  disabled={disabled || args.state.isValidating || (args.isLastStep && props.submitDisabled)}
                  onClick={() => {
                    if (args.isLastStep) { if (!props.submitDisabled) void args.submit(); }
                    else void args.next();
                  }}
                >
                  {disabled ? "提交中" : args.isLastStep ? "提交申请" : "继续"}
                </Button>
              </div>,
              footerHost,
            )
          }
        >
          <FormErrorSummary title={null} />
        </ExForm>
      </section>
      <div className={styles.footer} ref={setFooterHost}>
        <DialogDescription className={styles.footerDescription}>
          请如实填写资料，提交后等待社区审核。
        </DialogDescription>
      </div>
    </>
  );
}
// ExForm snapshots are frozen. Copy every draft container before reusing it as
// defaults, keeping the original in-memory File objects intact.
function restoreDraft(
  draft: NonNullable<CompleteJoinApplicationModalProps["initialDraft"]>,
) {
  return {
    ...draft,
    proofs: [...draft.proofs],
    form: {
      ...draft.form,
      discoveryChannels: [...draft.form.discoveryChannels],
      answers: { ...draft.form.answers },
      commitments: { ...draft.form.commitments },
    },
  };
}
function NewApplicationForm(props: FormProps) {
  const form = useForm({
    schema: newJoinApplicationSchema,

    defaultValues:
      props.initialDraft?.form.applicationType === "new"
        ? (restoreDraft(props.initialDraft) as NewJoinApplicationInput)
        : {
            qq: "",
            proofs: [],
            form: {
              applicationType: "new",
              birthDate: "2000-01-01",
              freeTime: "",
              discoveryChannels: [],
              answers: {
                fiveMExperience: "",
                emergencyRoleplayKnowledge: "",
                emergencyProceduresKnowledge: "",
                rpUnderstanding: "",
                frpUnderstanding: "",
              },
              commitments: {
                informationAccurate: false,
                obeyCommunityRules: false,
                acceptAcademyAttendanceConsequences: false,
              },
            },
          },
  });
  return <Wizard form={form} props={props} />;
}
function ExperiencedApplicationForm(props: FormProps) {
  const form = useForm({
    schema: experiencedJoinApplicationSchema,

    defaultValues:
      props.initialDraft?.form.applicationType === "experienced"
        ? (restoreDraft(props.initialDraft) as ExperiencedJoinApplicationInput)
        : {
            qq: "",
            proofs: [],
            form: {
              applicationType: "experienced",
              birthDate: "2000-01-01",
              freeTime: "",
              discoveryChannels: [],
              answers: {
                previousServer: "",
                leaveReason: "",
                previousDepartment: "",
                lawEnforcementExperience: "",
                highestRank: "",
                punishmentHistory: "",
                deescalationEssay: "",
                discretionEssay: "",
                transferReason: "",
              },
              commitments: {
                informationAccurate: false,
                obeyCommunityRules: false,
              },
            },
          },
  });
  return <Wizard form={form} props={props} />;
}

export const CompleteJoinApplicationModal = forwardRef<
  CompleteJoinApplicationModalHandle,
  CompleteJoinApplicationModalProps
>(function CompleteJoinApplicationModal(props, ref) {
  const formRef = useRef<InternalHandle>(null);
  useImperativeHandle(ref, () => ({
    setError: (message, field) => formRef.current?.setError(message, field),
    getDraft: () => formRef.current?.getDraft(),
  }));
  function locked() {
    return props.busy || formRef.current?.isSubmitting() === true;
  }
  function change(open: boolean) {
    if (!locked()) props.onOpenChange(open);
  }
  return (
    <Dialog open={props.open} onOpenChange={change}>
      <DialogContent
        className={
          props.children
            ? `${styles.modal} ${styles.resultModal}`
            : styles.modal
        }
        showCloseButton={false}
        onCloseAutoFocus={props.onCloseAutoFocus}
        onEscapeKeyDown={(event) => {
          if (locked()) event.preventDefault();
        }}
        onPointerDownOutside={(event) => {
          if (locked()) event.preventDefault();
        }}
        onInteractOutside={(event) => {
          if (locked()) event.preventDefault();
        }}
      >
        {props.children ? (
          <>
            <DialogHeader className={styles.header}>
              <DialogTitle className={styles.title}>
                {props.resultTitle ??
                  (props.applicationType === "new" ? "新玩家申请" : "调转申请")}
              </DialogTitle>
              <DialogDescription className="sr-only">
                申请结果与下一步
              </DialogDescription>
              <Button
                className={styles.close}
                variant="ghost"
                size="icon"
                aria-label="关闭申请"
                onClick={() => change(false)}
              >
                <X size={18} />
              </Button>
            </DialogHeader>
            <div className={styles.body}>{props.children}</div>
          </>
        ) : (
          props.open &&
          (props.applicationType === "new" ? (
            <NewApplicationForm
              key="new"
              {...props}
              onOpenChange={change}
              handleRef={formRef}
            />
          ) : (
            <ExperiencedApplicationForm
              key="experienced"
              {...props}
              onOpenChange={change}
              handleRef={formRef}
            />
          ))
        )}
      </DialogContent>
    </Dialog>
  );
});
