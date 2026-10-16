import type {
  FieldDefinition,
  FieldOption,
} from "@components/src/forms/ConfiguredField";
import type { JoinApplicationType } from "@components/src/join/applicationSchemas";

export const applicantCategoryOptions = [
  { value: "100", label: "普通成年申请人" },
  { value: "101", label: "普通未成年申请人" },
  { value: "102a", label: "曾任其他服务器管理" },
  { value: "102b", label: "曾任其他服务器技术" },
] as const satisfies readonly FieldOption[];
export const departmentOptions = [
  { value: "leo", label: "警察部门" },
  { value: "ems", label: "医疗和消防部门" },
] as const;
export const discoveryChannelOptions = [
  { value: "bilibili", label: "B站" },
  { value: "douyin", label: "抖音" },
  { value: "friends", label: "朋友介绍" },
  { value: "other", label: "其他" },
] as const;
export function joinApplicationSteps(
  type: JoinApplicationType,
): readonly string[] {
  return type === "new"
    ? ["联系方式", "基本资料", "玩法认知", "时间与来源", "确认提交"]
    : [
        "联系方式",
        "基本资料",
        "过往经历",
        "笔试与证明",
        "时间与来源",
        "确认提交",
      ];
}
export function joinApplicationFields(
  type: JoinApplicationType,
): readonly FieldDefinition[] {
  const common: FieldDefinition[] = [
    {
      name: "qq",
      label: "QQ 号码",
      step: 0,
      inputMode: "numeric",
    },
    {
      name: "form.birthDate",
      label: "出生日期",
      kind: "date",
      step: 1,
      description:
        "请选择 1990 年 1 月 1 日至 2016 年 1 月 1 日之间的真实出生日期，不会根据年龄来决定你是否通过。",
    },
    {
      name: "form.applicantCategory",
      label: "申请人类型",
      kind: "select",
      step: 1,
      options: applicantCategoryOptions,
    },
    {
      name: "form.department",
      label: "申请部门",
      kind: "select",
      step: 1,
      options: departmentOptions,
    },
  ];
  const answers: FieldDefinition[] =
    type === "new"
      ? [
          {
            name: "fiveMExperience",
            label: "是否接触过 FiveM，是否游玩过其他 RP 服务器？",
            presets: ["没有接触过"],
            description: "选择“其它”后，可填写你的实际经历。",
          },
          {
            name: "emergencyRoleplayKnowledge",
            label: "是否对“紧急职业模拟”这一种游玩方式有过了解？",
            presets: ["了解", "不了解"],
            description: "需要补充说明时，请选择“其它”。",
          },
          {
            name: "emergencyProceduresKnowledge",
            label:
              "是否对美国警察执法程序，或紧急救援、医疗处理流程有基本了解？",
          },
          {
            name: "rpUnderstanding",
            label: "是否知道什么是 RP？",
            description: "请谈谈你对 RP 的理解。",
          },
          {
            name: "frpUnderstanding",
            label: "是否知道什么是 FRP？",
            description: "请谈谈你对 FRP 的理解。",
          },
        ].map((field) => ({
          ...field,
          name: `form.answers.${field.name}`,
          step: 2,
          kind: "textarea",
          maxLength: 4000,
        }))
      : [
          { name: "previousServer", label: "以前所在服务器", maxLength: 256 },
          {
            name: "leaveReason",
            label: "离开以前所在服务器的原因",
            kind: "textarea",
          },
          {
            name: "previousDepartment",
            label: "以前所在部门",
            presets: ["巡逻", "交通", "特殊", "警探", "飞机", "医疗", "消防"],
            maxLength: 256,
            description: "列表中没有你的部门时，请选择“其它”填写。",
          },
          {
            name: "lawEnforcementExperience",
            label: "请介绍你的执法生涯经历",
            kind: "textarea",
          },
          { name: "highestRank", label: "最高警衔／等级", maxLength: 256 },
          {
            name: "punishmentHistory",
            label: "是否受过任何形式的处罚？",
            kind: "textarea",
            description: "如无处罚经历，也请明确回答“无”。",
          },
          {
            name: "deescalationEssay",
            label: "是否需要遵循“武力降级”原则？如果是，为什么？",
            kind: "textarea",
            step: 3,
            minLength: 150,
            description: "请详细说明你的判断，至少 150 个字符。",
          },
          {
            name: "discretionEssay",
            label: "在什么情况下可以使用“自由裁量权”？",
            kind: "textarea",
            step: 3,
            minLength: 150,
            description: "请结合情境说明，至少 150 个字符。",
          },
          {
            name: "transferReason",
            label: "为什么应该接受您的调转？",
            kind: "textarea",
            step: 3,
          },
        ].map((field) => ({
          ...field,
          name: `form.answers.${field.name}`,
          step: field.step ?? 2,
          kind: field.kind === "textarea" ? "textarea" : "text",
          maxLength: field.maxLength ?? 4000,
        }));
  return [
    ...common,
    ...answers,
    {
      name: "form.freeTime",
      label: "每周空闲时间",
      step: type === "new" ? 3 : 4,
      presets: ["每晚都有空", "每周三天以上", "每周三天以下"],
      maxLength: 256,
      description: "选择常见安排，或选择“其它”填写具体时间。",
    },
    {
      name: "form.discoveryChannels",
      label: "通过哪些方式了解到我们？",
      kind: "choices",
      step: type === "new" ? 3 : 4,
      options: discoveryChannelOptions,
      description: "至少选择一项，可以多选。",
    },
  ];
}
export function joinApplicationCommitments(
  type: JoinApplicationType,
): readonly { name: string; label: string }[] {
  const accurate = {
    name: "form.commitments.informationAccurate",
    label: "我确认以上信息真实无误。",
  };
  const obeyRules = {
    name: "form.commitments.obeyCommunityRules",
    label: "我确认能够遵守服务器规定与政策。",
  };
  return type === "new"
    ? [
        accurate,
        obeyRules,
        {
          name: "form.commitments.acceptAcademyAttendanceConsequences",
          label:
            "我清楚面试通过进入学院后，因自身原因缺课、旷课所产生的后果由自己承担。",
        },
      ]
    : [accurate, obeyRules];
}
