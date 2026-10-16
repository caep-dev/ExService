import { z } from "zod";

export const proofExtensions = [
  "png",
  "jpg",
  "jpeg",
  "gif",
  "bmp",
  "svg",
  "pdf",
  "doc",
  "docx",
  "xls",
  "xlsx",
  "ppt",
  "pptx",
  "txt",
  "zip",
  "rar",
  "7z",
] as const;
export const maxProofBytes = 10 * 1024 * 1024;
export const proofFileSchema = z
  .custom<File>(
    (value) => typeof File !== "undefined" && value instanceof File,
    "请选择文件",
  )
  .refine(
    (file) => file.size > 0 && file.size <= maxProofBytes,
    "每个文件须为 1 字节至 10 MiB",
  )
  .refine(
    (file) =>
      proofExtensions.some((extension) =>
        file.name.toLowerCase().endsWith(`.${extension}`),
      ),
    "不支持此文件扩展名",
  )
  .refine(
    (file) =>
      Array.from(file.name).length >= 1 &&
      Array.from(file.name).length <= 255 &&
      !/[\\/\u0000-\u001f\u007f-\u009f"<>:|?*]/u.test(file.name) &&
      file.name !== "." &&
      file.name !== "..",
    "文件名无效，请重命名后选择",
  );
export const proofFilesSchema = z
  .array(proofFileSchema)
  .max(5, "最多选择 5 个证明文件");

function text(min: number, max: number) {
  return z
    .string()
    .trim()
    .refine((value) => value.length > 0, "必须填写")
    .refine(
      (value) => value.length === 0 || Array.from(value).length >= min,
      `至少${min}个文字`,
    )
    .refine((value) => Array.from(value).length <= max, `至多${max}个文字`);
}

const birthDateSchema = z.string().refine((value) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return (
    !Number.isNaN(date.getTime()) &&
    date.toISOString().slice(0, 10) === value &&
    value <= new Date().toISOString().slice(0, 10)
  );
}, "请输入合法且不晚于 UTC 今日的出生日期");
const consent = z
  .boolean()
  .refine((value) => value === true, "请阅读并确认此项承诺")
  .transform(() => true as const);
const contact = {
  qq: z.string().regex(/^[0-9]{5,13}$/, "QQ 须为 5 至 13 位数字"),
};
const commonForm = {
  birthDate: birthDateSchema,
  applicantCategory: z.enum(["100", "101", "102a", "102b"], {
    error: "请选择申请人类型",
  }),
  department: z.enum(["leo", "ems"], { error: "请选择申请部门" }),
  freeTime: text(1, 256),
  discoveryChannels: z
    .array(z.enum(["bilibili", "douyin", "friends", "other"]))
    .min(1, "请至少选择一种了解方式")
    .max(4)
    .refine(
      (values) => new Set(values).size === values.length,
      "了解方式不能重复",
    ),
};

export const newJoinApplicationSchema = z.strictObject({
  ...contact,
  form: z.strictObject({
    ...commonForm,
    applicationType: z.literal("new"),
    answers: z.strictObject({
      fiveMExperience: text(1, 4000),
      emergencyRoleplayKnowledge: text(1, 4000),
      emergencyProceduresKnowledge: text(1, 4000),
      rpUnderstanding: text(1, 4000),
      frpUnderstanding: text(1, 4000),
    }),
    commitments: z.strictObject({
      informationAccurate: consent,
      obeyCommunityRules: consent,
      acceptAcademyAttendanceConsequences: consent,
    }),
  }),
  proofs: z.array(proofFileSchema).max(0, "全新玩家申请不接收证明文件"),
});
export const experiencedJoinApplicationSchema = z.strictObject({
  ...contact,
  form: z.strictObject({
    ...commonForm,
    applicationType: z.literal("experienced"),
    answers: z.strictObject({
      previousServer: text(1, 256),
      leaveReason: text(1, 4000),
      previousDepartment: text(1, 256),
      lawEnforcementExperience: text(1, 4000),
      highestRank: text(1, 256),
      punishmentHistory: text(1, 4000),
      deescalationEssay: text(150, 4000),
      discretionEssay: text(150, 4000),
      transferReason: text(1, 4000),
    }),
    commitments: z.strictObject({
      informationAccurate: consent,
      obeyCommunityRules: consent,
    }),
  }),
  proofs: proofFilesSchema,
});

export type NewJoinApplicationDraft = z.infer<typeof newJoinApplicationSchema>;
export type ExperiencedJoinApplicationDraft = z.infer<
  typeof experiencedJoinApplicationSchema
>;
export type NewJoinApplicationInput = z.input<typeof newJoinApplicationSchema>;
export type ExperiencedJoinApplicationInput = z.input<
  typeof experiencedJoinApplicationSchema
>;
export type JoinApplicationDraft =
  | NewJoinApplicationDraft
  | ExperiencedJoinApplicationDraft;
export type JoinApplicationType =
  JoinApplicationDraft["form"]["applicationType"];

// Each step receives only its own paths. Reuse the same rules as full submission.
const contactStep = z.object(contact);
const basicStep = z.object({
  form: z.object({
    birthDate: commonForm.birthDate,
    applicantCategory: commonForm.applicantCategory,
    department: commonForm.department,
  }),
});
const timeStep = z.object({
  form: z.object({
    freeTime: commonForm.freeTime,
    discoveryChannels: commonForm.discoveryChannels,
  }),
});
const experiencedAnswers =
  experiencedJoinApplicationSchema.shape.form.shape.answers;
export const newApplicationStepSchemas = [
  contactStep,
  basicStep,
  z.object({
    form: z.object({
      answers: newJoinApplicationSchema.shape.form.shape.answers,
    }),
  }),
  timeStep,
  z.object({
    form: z.object({
      commitments: newJoinApplicationSchema.shape.form.shape.commitments,
    }),
  }),
] as const;
export const experiencedApplicationStepSchemas = [
  contactStep,
  basicStep,
  z.object({
    form: z.object({
      answers: experiencedAnswers.pick({
        previousServer: true,
        leaveReason: true,
        previousDepartment: true,
        lawEnforcementExperience: true,
        highestRank: true,
        punishmentHistory: true,
      }),
    }),
  }),
  z.object({
    form: z.object({
      answers: experiencedAnswers.pick({
        deescalationEssay: true,
        discretionEssay: true,
        transferReason: true,
      }),
    }),
    proofs: proofFilesSchema,
  }),
  timeStep,
  z.object({
    form: z.object({
      commitments:
        experiencedJoinApplicationSchema.shape.form.shape.commitments,
    }),
  }),
] as const;
