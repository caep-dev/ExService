// @vitest-environment jsdom
import { createRef, useRef, useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  CompleteJoinApplicationModal,
  type CompleteJoinApplicationModalHandle,
} from "@components/src/join/CompleteJoinApplicationModal";
import type { JoinApplicationDraft } from "@components/src/join/applicationSchemas";

afterEach(cleanup);
class TestResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
vi.stubGlobal("ResizeObserver", TestResizeObserver);
vi.stubGlobal(
  "matchMedia",
  vi.fn(() => ({
    matches: false,
    addEventListener() {},
    removeEventListener() {},
  })),
);
function Harness({
  type = "new",
  onSubmit = vi.fn(async () => {}),
  busy = false,
}: {
  type?: "new" | "experienced";
  onSubmit?: (draft: JoinApplicationDraft) => Promise<void>;
  busy?: boolean;
}) {
  const [step, setStep] = useState(0);
  const [open, setOpen] = useState(true);
  return (
    <CompleteJoinApplicationModal
      open={open}
      applicationType={type}
      step={step}
      busy={busy}
      onStepChange={setStep}
      onOpenChange={setOpen}
      onSubmit={onSubmit}
    />
  );
}
async function contact(
  user: ReturnType<typeof userEvent.setup>,
  name = "你的名字",
) {
  await user.type(screen.getByLabelText("QQ 号码"), "0012345");
}

async function choose(
  user: ReturnType<typeof userEvent.setup>,
  label: string,
  option: string,
) {
  await user.click(screen.getByRole("combobox", { name: label }));
  await user.click(await screen.findByRole("option", { name: option }));
}
HTMLElement.prototype.hasPointerCapture = () => false;
HTMLElement.prototype.setPointerCapture = () => {};
HTMLElement.prototype.releasePointerCapture = () => {};
HTMLElement.prototype.scrollIntoView = () => {};

describe("完整申请 Modal", () => {
  it.each(["new", "experienced"] as const)(
    "uses the ExUI date picker with the default and inclusive birth-date range for %s applications",
    async (type) => {
      const user = userEvent.setup();
      render(
        <CompleteJoinApplicationModal
          open
          applicationType={type}
          step={1}
          busy={false}
          onStepChange={vi.fn()}
          onOpenChange={vi.fn()}
          onSubmit={vi.fn()}
        />,
      );
      const trigger = screen.getByRole("button", { name: "出生日期" });
      expect(trigger.textContent).toContain("2000-01-01");
      expect(document.querySelector('input[type="date"]')).toBeNull();
      await user.click(trigger);
      const year = screen.getByRole("combobox", { name: /year/i });
      await user.click(year);
      expect(screen.queryByRole("option", { name: "1989" })).toBeNull();
      expect(screen.getByRole("option", { name: "1990" })).toBeTruthy();
      expect(screen.getByRole("option", { name: "2016" })).toBeTruthy();
      expect(screen.queryByRole("option", { name: "2017" })).toBeNull();
      await user.click(screen.getByRole("option", { name: "1990" }));
      expect(document.querySelector<HTMLButtonElement>('[data-day="1990-01-01"] button')?.disabled).toBe(false);
      await user.click(document.querySelector<HTMLButtonElement>('[data-day="1990-01-01"] button')!);
      expect(trigger.textContent).toContain("1990-01-01");
      await user.click(trigger);
      const nextYear = screen.getByRole("combobox", { name: /year/i });
      await user.click(nextYear);
      await user.click(screen.getByRole("option", { name: "2016" }));
      expect(document.querySelector<HTMLButtonElement>('[data-day="2016-01-01"] button')?.disabled).toBe(false);
      expect(document.querySelector<HTMLButtonElement>('[data-day="2016-01-02"] button')?.disabled).toBe(true);
      await user.click(document.querySelector<HTMLButtonElement>('[data-day="2016-01-01"] button')!);
      expect(trigger.textContent).toContain("2016-01-01");
    },
  );
  it.each(["text", "checkbox"] as const)(
    "preserves scroll position when editing %s without changing steps",
    async (control) => {
      const user = userEvent.setup();
      render(
        <CompleteJoinApplicationModal
          open
          applicationType={control === "text" ? "experienced" : "new"}
          step={control === "text" ? 3 : 4}
          busy={false}
          onStepChange={vi.fn()}
          onOpenChange={vi.fn()}
          onSubmit={vi.fn()}
        />,
      );
      const body = screen.getByRole("region", {
        name: control === "text" ? "笔试与证明内容" : "确认提交内容",
      });
      body.scrollTop = 200;
      if (control === "text")
        await user.type(
          screen.getByLabelText("为什么应该接受您的调转？"),
          "继续填写",
        );
      else
        await user.click(
          screen.getByRole("checkbox", { name: "我确认以上信息真实无误。" }),
        );
      expect(body.scrollTop).toBe(200);
    },
  );
  it("focuses a server-rejected email after returning from the confirmation step", async () => {
    const ref = createRef<CompleteJoinApplicationModalHandle>();
    function ConflictHarness() {
      const [step, setStep] = useState(4);
      return (
        <CompleteJoinApplicationModal
          ref={ref}
          open
          applicationType="new"
          step={step}
          busy={false}
          onStepChange={setStep}
          onOpenChange={vi.fn()}
          onSubmit={vi.fn()}
        />
      );
    }
    render(<ConflictHarness />);
    act(() => ref.current?.setError("该邮箱已有申请", "qq"));
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByLabelText("QQ 号码")),
    );
  });
  it("reveals custom availability only after choosing other and validates its empty answer", async () => {
    const user = userEvent.setup();
    function TimeHarness() {
      const [step, setStep] = useState(3);
      return (
        <CompleteJoinApplicationModal
          open
          applicationType="new"
          step={step}
          busy={false}
          onStepChange={setStep}
          onOpenChange={vi.fn()}
          onSubmit={vi.fn()}
        />
      );
    }
    render(<TimeHarness />);
    expect(
      screen.queryByRole("textbox", { name: "每周空闲时间（其它）" }),
    ).toBeNull();
    await choose(user, "每周空闲时间", "其它");
    expect(
      screen.getByRole("textbox", { name: "每周空闲时间（其它）" }),
    ).toBeTruthy();
    await user.click(screen.getByRole("checkbox", { name: "朋友介绍" }));
    await user.click(screen.getByRole("button", { name: "继续" }));
    expect(screen.queryByRole("button", { name: "提交申请" })).toBeNull();
    await choose(user, "每周空闲时间", "每晚都有空");
    expect(
      screen.queryByRole("textbox", { name: "每周空闲时间（其它）" }),
    ).toBeNull();
    await user.click(screen.getByRole("button", { name: "继续" }));
    expect(await screen.findByText("每晚都有空")).toBeTruthy();
  });
  it("validates only the current step and preserves earlier values when going backwards", async () => {
    const user = userEvent.setup();
    const submitted = vi.fn(async () => {});
    render(<Harness onSubmit={submitted} />);
    await contact(user);
    screen.getByRole("region", { name: "联系方式内容" }).scrollTop = 200;
    await user.click(screen.getByRole("button", { name: /继续|检查申请/ }));
    expect(screen.getByRole("button", { name: "出生日期" }).textContent).toContain("2000-01-01");
    expect(screen.getByRole("region", { name: "基本资料内容" }).scrollTop).toBe(
      0,
    );
    expect(submitted).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "上一步" }));
    expect((screen.getByLabelText("QQ 号码") as HTMLInputElement).value).toBe(
      "0012345",
    );
  });
  it("restores focus to the opener through onCloseAutoFocus", async () => {
    const user = userEvent.setup();
    function RestoreHarness() {
      const [open, setOpen] = useState(false);
      const opener = useRef<HTMLButtonElement>(null);
      return (
        <>
          <button ref={opener} onClick={() => setOpen(true)}>
            打开申请
          </button>
          <CompleteJoinApplicationModal
            open={open}
            applicationType="new"
            step={0}
            busy={false}
            onStepChange={vi.fn()}
            onOpenChange={setOpen}
            onSubmit={vi.fn()}
            onCloseAutoFocus={(event) => {
              event.preventDefault();
              opener.current?.focus();
            }}
          />
        </>
      );
    }
    render(<RestoreHarness />);
    const opener = screen.getByRole("button", { name: "打开申请" });
    await user.click(opener);
    await user.click(screen.getByRole("button", { name: "关闭申请" }));
    await waitFor(() => expect(document.activeElement).toBe(opener));
  });
  it("runs full validation and focuses the earliest missing field on final submission", async () => {
    const user = userEvent.setup();
    function FinalHarness() {
      const [step, setStep] = useState(4);
      return (
        <CompleteJoinApplicationModal
          open
          applicationType="new"
          step={step}
          busy={false}
          onStepChange={setStep}
          onOpenChange={vi.fn()}
          onSubmit={vi.fn()}
        />
      );
    }
    render(<FinalHarness />);
    await user.click(screen.getByRole("button", { name: "提交申请" }));
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByLabelText("QQ 号码")),
    );
  });
  it("clears drafts on close and isolates types when switching", async () => {
    const user = userEvent.setup();
    const props = {
      open: true,
      applicationType: "new" as const,
      step: 0,
      busy: false,
      onStepChange: vi.fn(),
      onOpenChange: vi.fn(),
      onSubmit: vi.fn(),
    };
    const view = render(<CompleteJoinApplicationModal {...props} />);
    await contact(user);
    view.rerender(<CompleteJoinApplicationModal {...props} open={false} />);
    view.rerender(<CompleteJoinApplicationModal {...props} />);
    expect((screen.getByLabelText("QQ 号码") as HTMLInputElement).value).toBe("");
    await contact(user);
    view.rerender(
      <CompleteJoinApplicationModal {...props} applicationType="experienced" />,
    );
    expect((screen.getByLabelText("QQ 号码") as HTMLInputElement).value).toBe(
      "",
    );
  });
  it("blocks Esc, outside interaction and the close button while busy", async () => {
    const user = userEvent.setup();
    const change = vi.fn();
    const view = render(
      <CompleteJoinApplicationModal
        open
        applicationType="new"
        step={0}
        busy
        onStepChange={vi.fn()}
        onOpenChange={change}
        onSubmit={vi.fn()}
      />,
    );
    await user.keyboard("{Escape}");
    const overlay = document.querySelector('[data-slot="dialog-overlay"]')!;
    fireEvent.pointerDown(overlay, { button: 0, ctrlKey: false });
    expect(
      (screen.getByRole("button", { name: "关闭申请" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    expect(change).not.toHaveBeenCalled();
    view.unmount();
  });
  it("shows root/field errors through the handle and preserves the draft", async () => {
    const user = userEvent.setup();
    const ref = createRef<CompleteJoinApplicationModalHandle>();
    render(
      <CompleteJoinApplicationModal
        ref={ref}
        open
        applicationType="new"
        step={0}
        busy={false}
        onStepChange={vi.fn()}
        onOpenChange={vi.fn()}
        onSubmit={vi.fn()}
        serverAction={<a href="/join/result">查询申请结果</a>}
      />,
    );
    await contact(user);
    act(() => ref.current?.setError("该邮箱已有申请，不能重复提交"));
    expect(screen.getByRole("alert").textContent).toContain("该邮箱已有申请");
    expect(screen.getByRole("link", { name: "查询申请结果" })).toBeTruthy();
    expect((screen.getByLabelText("QQ 号码") as HTMLInputElement).value).toBe(
      "0012345",
    );
  });
  it("accepts chooser/drop/paste, keeps files backwards, removes files and rejects a sixth file", async () => {
    const user = userEvent.setup();
    function FilesHarness() {
      const [step, setStep] = useState(3);
      return (
        <CompleteJoinApplicationModal
          open
          applicationType="experienced"
          step={step}
          busy={false}
          onStepChange={setStep}
          onOpenChange={vi.fn()}
          onSubmit={vi.fn()}
        />
      );
    }
    render(<FilesHarness />);
    const chooser = screen.getByLabelText(
      "证明文件（可选）",
    ) as HTMLInputElement;
    const area = screen.getByRole("group", { name: "证明文件输入" });
    await user.upload(chooser, new File(["first"], "first.txt"));
    fireEvent.drop(area, {
      dataTransfer: { files: [new File(["second"], "second.pdf")] },
    });
    fireEvent.paste(area, {
      clipboardData: { files: [new File(["third"], "third.zip")] },
    });
    expect(screen.getByText("first.txt")).toBeTruthy();
    expect(screen.getByText("second.pdf")).toBeTruthy();
    expect(screen.getByText("third.zip")).toBeTruthy();
    fireEvent.change(
      screen.getByLabelText("是否需要遵循“武力降级”原则？如果是，为什么？"),
      { target: { value: "😀".repeat(150) } },
    );
    fireEvent.change(
      screen.getByLabelText("在什么情况下可以使用“自由裁量权”？"),
      { target: { value: "字".repeat(150) } },
    );
    fireEvent.change(screen.getByLabelText("为什么应该接受您的调转？"), {
      target: { value: "我有经验" },
    });
    await user.click(screen.getByRole("button", { name: /继续|检查申请/ }));
    expect(screen.getByLabelText("每周空闲时间")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "上一步" }));
    expect(screen.getByText("third.zip")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "移除 second.pdf" }));
    expect(screen.queryByText("second.pdf")).toBeNull();
    fireEvent.drop(screen.getByRole("group", { name: "证明文件输入" }), {
      dataTransfer: {
        files: [
          new File(["4"], "four.txt"),
          new File(["5"], "five.txt"),
          new File(["6"], "six.txt"),
          new File(["7"], "seven.txt"),
        ],
      },
    });
    expect(await screen.findByText("最多选择 5 个证明文件")).toBeTruthy();
    expect(screen.queryByText("seven.txt")).toBeNull();
  });
  it("submits a full new draft with true commitments and locks internal submission until failure settles", async () => {
    const user = userEvent.setup();
    let reject: (() => void) | undefined;
    const onSubmit = vi.fn(
      (_draft: JoinApplicationDraft) =>
        new Promise<void>((_, rejectPromise) => {
          reject = () => rejectPromise(new Error("internal detail"));
        }),
    );
    render(<Harness onSubmit={onSubmit} />);
    await contact(user);
    await user.click(screen.getByRole("button", { name: /继续|检查申请/ }));
    expect(screen.getByRole("button", { name: "出生日期" }).textContent).toContain("2000-01-01");
    await choose(user, "申请人类型", "普通成年申请人");
    await choose(user, "申请部门", "警察部门");
    await user.click(screen.getByRole("button", { name: /继续|检查申请/ }));
    await choose(
      user,
      "是否接触过 FiveM，是否游玩过其他 RP 服务器？",
      "没有接触过",
    );
    await choose(
      user,
      "是否对“紧急职业模拟”这一种游玩方式有过了解？",
      "不了解",
    );
    for (const label of [
      "是否对美国警察执法程序，或紧急救援、医疗处理流程有基本了解？",
      "是否知道什么是 RP？",
      "是否知道什么是 FRP？",
    ])
      fireEvent.change(screen.getByLabelText(label), {
        target: { value: "愿意学习角色扮演" },
      });
    await user.click(screen.getByRole("button", { name: /继续|检查申请/ }));
    await choose(user, "每周空闲时间", "每晚都有空");
    await user.click(screen.getByRole("checkbox", { name: "朋友介绍" }));
    await user.click(screen.getByRole("button", { name: /继续|检查申请/ }));
    expect(screen.getByText("0012345")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "提交申请" }));
    expect(onSubmit).not.toHaveBeenCalled();
    for (const checkbox of screen.getAllByRole("checkbox"))
      await user.click(checkbox);
    await user.click(screen.getByRole("button", { name: "提交申请" }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledOnce());
    const draft = onSubmit.mock.calls[0]![0];
    expect(draft.qq).toBe("0012345");
    expect(draft.proofs).toEqual([]);
    expect(draft.form.commitments).toEqual({
      informationAccurate: true,
      obeyCommunityRules: true,
      acceptAcademyAttendanceConsequences: true,
    });
    await user.keyboard("{Escape}");
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(
      (screen.getByRole("button", { name: "关闭申请" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    act(() => reject?.());
    expect(
      await screen.findByText(
        "提交失败，请稍后重试。已填写的资料与文件会保留。",
      ),
    ).toBeTruthy();
    expect(screen.queryByText("internal detail")).toBeNull();
    await user.click(screen.getByRole("button", { name: "返回修改" }));
    expect(
      screen.getByRole("combobox", { name: "每周空闲时间" }).textContent,
    ).toContain("每晚都有空");
  });
  it("submits all experienced answers and preserves actual custom text and File identities after failure", async () => {
    const user = userEvent.setup();
    const proof = new File(["proof data"], "长文件名称证明.txt");
    const onSubmit = vi.fn(async (_draft: JoinApplicationDraft) => {
      throw new Error("private error");
    });
    render(<Harness type="experienced" onSubmit={onSubmit} />);
    await contact(user, "QQ 号码");
    await user.click(screen.getByRole("button", { name: /继续|检查申请/ }));
    expect(screen.getByRole("button", { name: "出生日期" }).textContent).toContain("2000-01-01");
    await choose(user, "申请人类型", "曾任其他服务器技术");
    await choose(user, "申请部门", "医疗和消防部门");
    await user.click(screen.getByRole("button", { name: /继续|检查申请/ }));
    for (const label of [
      "以前所在服务器",
      "离开以前所在服务器的原因",
      "请介绍你的执法生涯经历",
      "最高警衔／等级",
      "是否受过任何形式的处罚？",
    ])
      fireEvent.change(screen.getByLabelText(label), {
        target: { value: "如实回答过往经历" },
      });
    await choose(user, "以前所在部门", "巡逻");
    await choose(user, "以前所在部门", "其它");
    fireEvent.change(screen.getByLabelText("以前所在部门（其它）"), {
      target: { value: "航空救援" },
    });
    await user.click(screen.getByRole("button", { name: /继续|检查申请/ }));
    fireEvent.change(
      screen.getByLabelText("是否需要遵循“武力降级”原则？如果是，为什么？"),
      { target: { value: "😀".repeat(149) } },
    );
    fireEvent.change(
      screen.getByLabelText("在什么情况下可以使用“自由裁量权”？"),
      { target: { value: "字".repeat(150) } },
    );
    fireEvent.change(screen.getByLabelText("为什么应该接受您的调转？"), {
      target: { value: "愿意持续参与与学习" },
    });
    await user.upload(screen.getByLabelText("证明文件（可选）"), proof);
    await user.click(screen.getByRole("button", { name: /继续|检查申请/ }));
    expect(
      screen.getByLabelText("是否需要遵循“武力降级”原则？如果是，为什么？"),
    ).toBeTruthy();
    fireEvent.change(
      screen.getByLabelText("是否需要遵循“武力降级”原则？如果是，为什么？"),
      { target: { value: "😀".repeat(150) } },
    );
    await user.click(screen.getByRole("button", { name: /继续|检查申请/ }));
    await choose(user, "每周空闲时间", "每周三天以上");
    await choose(user, "每周空闲时间", "其它");
    fireEvent.change(screen.getByLabelText("每周空闲时间（其它）"), {
      target: { value: "周末白天和周二晚间" },
    });
    await user.click(screen.getByRole("checkbox", { name: "B站" }));
    await user.click(screen.getByRole("checkbox", { name: "其他" }));
    await user.click(screen.getByRole("button", { name: /继续|检查申请/ }));
    expect(screen.getByText("航空救援")).toBeTruthy();
    expect(screen.getByText("周末白天和周二晚间")).toBeTruthy();
    expect(screen.getAllByRole("checkbox")).toHaveLength(2);
    await user.click(
      screen.getByRole("checkbox", { name: "我确认以上信息真实无误。" }),
    );
    await user.click(
      screen.getByRole("checkbox", { name: "我确认能够遵守服务器规定与政策。" }),
    );
    await user.click(screen.getByRole("button", { name: "提交申请" }));
    expect(
      await screen.findByText(
        "提交失败，请稍后重试。已填写的资料与文件会保留。",
      ),
    ).toBeTruthy();
    expect(onSubmit).toHaveBeenCalledOnce();
    const draft = onSubmit.mock.calls[0]![0];
    expect(draft.form.applicationType).toBe("experienced");
    expect(draft.form.freeTime).toBe("周末白天和周二晚间");
    expect(draft.form.discoveryChannels).toEqual(["bilibili", "other"]);
    expect(draft.form.commitments).toEqual({
      informationAccurate: true,
      obeyCommunityRules: true,
    });
    expect(draft.proofs[0]).toBe(proof);
    expect(Object.keys(draft.form.answers)).toHaveLength(9);
    await user.click(screen.getByRole("button", { name: "返回修改" }));
    await user.click(screen.getByRole("button", { name: "上一步" }));
    expect(screen.getByText("长文件名称证明.txt")).toBeTruthy();
    expect(
      (screen.getByLabelText("为什么应该接受您的调转？") as HTMLTextAreaElement)
        .value,
    ).toBe("愿意持续参与与学习");
  });
});
