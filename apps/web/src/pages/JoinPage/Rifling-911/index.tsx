import { useEffect, useRef, useState } from "react";
import { Link } from "react-router";
import {
  Accordion,
  AccordionItem,
  AccordionTrigger,
  AccordionContent,
  Button,
  ExMessage,
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription,
} from "@exre/exui";
import { ArrowUpRight, CircleCheck } from "lucide-react";
import { HalftoneDots } from "@paper-design/shaders-react";
import { ExAxiosError } from "@workspace/sdk/http/browser";
import {
  CompleteJoinApplicationModal,
  type CompleteJoinApplicationModalHandle,
  type JoinApplicationDraft,
  type JoinApplicationType,
} from "@workspace/components";
import {
  JoinApplicationTextLimitError,
  submitApplication,
} from "@web/src/join/client";
import { communityDestinations, communityLinks } from "@web/src/join/community";
import { getJoinHeroImages } from "@web/src/join/hero-images";
import styles from "@web/src/pages/JoinPage/Rifling-911/JoinPage.module.scss";
import type { components } from '@workspace/api-client';
import { api } from '@web/src/api/client';
import { currentCommunityToken, useCommunityToken } from '@web/src/join/session';
import { CommunityAuthentication } from '@web/src/join/CommunityAuthentication';
import { IdentityLinksExperience } from '@web/src/settings/IdentityLinksExperience';
import { removeMatchingToken } from '@web/src/auth/storage';

const heroImages = getJoinHeroImages("rifling-911");

export function JoinPage() {
  const token = useCommunityToken();
  const previousToken = useRef(token);
  const [authOpen, setAuthOpen] = useState(false), [linksOpen, setLinksOpen] = useState(false), [statusReload, setStatusReload] = useState(0);
  const [community, setCommunity] = useState<components['schemas']['Community'] | null>(null);
  const [access, setAccess] = useState<{ token: string; account: components['schemas']['CurrentUser']; status: components['schemas']['MyCommunityStatus'] } | null>(null);
  const [accessError, setAccessError] = useState<string | null>(null);
  const currentAccess = access?.token === token ? access : null;
  const [heroIndex, setHeroIndex] = useState(0);
  const [hasSubmitted, setHasSubmitted] = useState(false);
  const [applicationType, setApplicationType] =
    useState<JoinApplicationType | null>(null);
  const [step, setStep] = useState(0),
    [received, setReceived] = useState(false),
    [busy, setBusy] = useState(false);
  const [serverAction, setServerAction] = useState<"query" | "login" | null>(
    null,
  );
  const pending = useRef(false),
    live = useRef(false),
    form = useRef<CompleteJoinApplicationModalHandle>(null);
  const trigger = useRef<HTMLButtonElement | null>(null);
  const drafts = useRef<
    Partial<
      Record<
        JoinApplicationType,
        {
          values: NonNullable<
            ReturnType<CompleteJoinApplicationModalHandle["getDraft"]>
          >;
          step: number;
        }
      >
    >
  >({});
  useEffect(() => {
    if (previousToken.current !== null && previousToken.current !== token) {
      drafts.current = {}; setApplicationType(null); setStep(0); setReceived(false); setHasSubmitted(false); setBusy(false); pending.current = false; setLinksOpen(false); setAuthOpen(false);
    }
    previousToken.current = token;
  }, [token]);
  useEffect(() => {
    const abort = new AbortController(); setAccess(null); setCommunity(null); setAccessError(null);
    void api.GET('/communities/{communityId}', { params: { path: { communityId: 'rifling-911' } }, signal: abort.signal, alert: false })
      .then(value => { if (!abort.signal.aborted) setCommunity(value) })
      .catch(() => { if (!abort.signal.aborted) setAccessError('无法读取社区要求，请重试'); });
    if (token) void Promise.all([
      api.GET('/auth/me', { headers: { Authorization: `Bearer ${token}` }, signal: abort.signal, alert: false }),
      api.GET('/auth/me/communities/{communityId}', { params: { path: { communityId: 'rifling-911' } }, headers: { Authorization: `Bearer ${token}` }, signal: abort.signal, alert: false }),
    ]).then(([account, status]) => { if (!abort.signal.aborted && currentCommunityToken() === token) setAccess({ token, account, status }); })
      .catch(issue => { if (!abort.signal.aborted && currentCommunityToken() === token) {
        setAccessError('无法确认本人申请状态，请重试');
        if (issue instanceof ExAxiosError && issue.status === 401) removeMatchingToken(localStorage, token);
      } });
    return () => abort.abort();
  }, [token, statusReload]);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);
  function open(type: JoinApplicationType, button: HTMLButtonElement) {
    if (pending.current || hasSubmitted || currentAccess?.status.application) return;
    trigger.current = button;
    setReceived(false);
    setServerAction(null);
    setStep(drafts.current[type]?.step ?? 0);
    setApplicationType(type);
  }
  function close() {
    if (!pending.current) {
      if (applicationType && !received) {
        const values = form.current?.getDraft();
        if (values) drafts.current[applicationType] = { values, step };
      }
      setApplicationType(null);
      setReceived(false);
      setServerAction(null);
    }
  }
  async function submit(draft: JoinApplicationDraft) {
    if (pending.current) return;
    if (!token) { setAuthOpen(true); return; }
    if (!currentAccess || !community) { form.current?.setError('请先刷新并确认本人申请状态'); return; }
    if (hasSubmitted || currentAccess.status.application) { form.current?.setError('本账号已提交过该社区申请，不能重复提交'); setServerAction('query'); return; }
    if (!currentAccess.status.requirementsMet) { setLinksOpen(true); form.current?.setError('请先满足社区关联要求，再确认提交'); return; }
    const submittedToken = token;
    const active = () => live.current && currentCommunityToken() === submittedToken;
    pending.current = true;
    setBusy(true);
    setServerAction(null);
    try {
      const result = await submitApplication(draft, 'rifling-911', submittedToken);
      if (!active()) return;
      if (result.status === "received") {
        delete drafts.current[draft.form.applicationType];
        setReceived(true);
        setHasSubmitted(true);
        ExMessage.info("申请已收到，请等待社区审核安排");
        return;
      }
    } catch (error) {
      if (!active()) return;
      if (error instanceof JoinApplicationTextLimitError) { form.current?.setError(error.message); return; }
      const status = error instanceof ExAxiosError ? error.status : undefined;
      const code = error instanceof ExAxiosError ? error.code : undefined;
      if (
        status === 409 &&
        code === "JOIN_APPLICATION_EXISTS"
      ) {
        form.current?.setError("本账号已提交过该社区申请，不能重复提交");
        setServerAction("query");
        setHasSubmitted(true);
        setStatusReload(value => value + 1);
      } else if (code === 'COMMUNITY_REQUIREMENT_UNMET') {
        form.current?.setError('当前社区关联要求尚未满足，请刷新并关联 Cfx'); setStatusReload(value => value + 1); setLinksOpen(true);
      } else if (status === 401) {
        removeMatchingToken(localStorage, submittedToken);
      } else {
        const message =
          status === 429
            ? "提交过于频繁，请稍后重试"
            : status === 413
              ? "申请文字资料或证明文件超出大小限制，请缩短回答或检查附件数量与大小后重试"
              : status === 415
                ? "证明文件格式不受支持，请检查后重试"
                : status === 503
                  ? "当前上传繁忙，请稍后重试"
                  : error instanceof ExAxiosError ? "提交失败，请检查资料并重试" : "提交失败，请检查网络并重试";
        form.current?.setError(message);
      }
    } finally {
      if (active()) { pending.current = false; setBusy(false); }
    }
  }
  const heroImage = heroImages[heroIndex];
  const artwork = heroImage && (
    <HalftoneDots
      key={heroImage}
      width={1280}
      height={720}
      image={heroImage}
      colorBack="#f2f1e8"
      colorFront="#2b2b2b"
      originalColors
      type="gooey"
      grid="hex"
      inverted={false}
      size={0.5}
      radius={1.25}
      contrast={0.4}
      grainMixer={0.2}
      grainOverlay={0.2}
      grainSize={0.5}
      fit="cover"
    />
  );
  return (
    <main className={styles.page}>
      <header className={styles.hero}>
        {heroImage &&
          (heroImages.length > 1 ? (
            <button
              type="button"
              className={styles.heroArtwork}
              aria-label={`切换背景图片，当前第 ${heroIndex + 1} 张，共 ${heroImages.length} 张`}
              onClick={() =>
                setHeroIndex((index) => (index + 1) % heroImages.length)
              }
            >
              {artwork}
            </button>
          ) : (
            <div className={styles.heroArtwork} aria-hidden="true">
              {artwork}
            </div>
          ))}
        <div className={styles.heroContent}>
          <p className={styles.eyebrow}>Rifling 911 · Emergency Roleplay</p>
          <h1>
            每一次出勤，
            <br />
            都是新的故事。
          </h1>
          <p className={styles.introduction}>
            在紧急职业模拟中一起创造故事。
            <br />
            找到属于你的角色，成为社区的一员。
          </p>
          <div className={styles.actions} aria-label="申请入口">
            <Button
              className={styles.primaryAction}
              disabled={busy || Boolean(currentAccess?.status.application) || hasSubmitted}
              onClick={(event) => open("new", event.currentTarget)}
            >
              新玩家申请 <ArrowUpRight aria-hidden="true" />
            </Button>
            <Button
              className={styles.secondaryAction}
              variant="outline"
              disabled={busy || Boolean(currentAccess?.status.application) || hasSubmitted}
              onClick={(event) => open("experienced", event.currentTarget)}
            >
              调转申请 <ArrowUpRight aria-hidden="true" />
            </Button>
          </div>
          <p>{community ? `${community.displayName}：${community.requiresCfx ? '提交申请需要关联 Cfx' : '无需第三方关联'}` : '正在读取社区要求'}</p>
          {currentAccess?.status.application && <p>本账号已有申请，请查看本人结果；不能重新提交。</p>}
          {accessError && <p role="alert">{accessError}</p>}
          <Button variant="outline" onClick={() => setStatusReload(value => value + 1)}>刷新申请资格</Button>
          {token && <Button variant="outline" onClick={() => setLinksOpen(true)}>管理关联账户</Button>}
          <p className={styles.experienceNote}>
            调转申请适用于拥有 100 小时以上相关经历的玩家
          </p>
          <p className={styles.query}>
            已经提交过申请？{" "}
            <Link to="/join/result">
              查询申请结果 <ArrowUpRight aria-hidden="true" />
            </Link>
          </p>
        </div>
      </header>
      <div className={styles.information}>
        <section className={styles.section} aria-labelledby="join-community">
          <h2 id="join-community">社区入口</h2>
          <div className={styles.communityActions}>
            {communityDestinations.map((link) =>
              link.url ? (
                <Button key={link.label} asChild variant="outline">
                  <a href={link.url} target="_blank" rel="noopener noreferrer">
                    {link.label} <ArrowUpRight aria-hidden="true" />
                  </a>
                </Button>
              ) : (
                <Button key={link.label} variant="outline" disabled>
                  {link.label} <ArrowUpRight aria-hidden="true" />
                </Button>
              ),
            )}
          </div>
        </section>
        <section className={styles.section} aria-labelledby="join-requirements">
          <h2 id="join-requirements">申请须知</h2>
          <p>
            申请前请阅读社区置顶指引，确认理解社区规则。请先注册并登录 Exre 账号，满足社区关联要求后如实提交完整资料。
          </p>
          <ul className={styles.requirements}>
            <li>
              <span aria-hidden="true">01</span>
              <div>
                <h3>年满 17 周岁且完成高中课程</h3>
                <p>具备成熟的理解能力。</p>
              </div>
            </li>
            <li>
              <span aria-hidden="true">02</span>
              <div>
                <h3>具备基本英语与清晰表达能力</h3>
                <p>在角色扮演中有效沟通。</p>
              </div>
            </li>
            <li>
              <span aria-hidden="true">03</span>
              <div>
                <h3>符合社区任职要求</h3>
                <p>不担任直接干涉其他服务器行政事务的主要职务。</p>
              </div>
            </li>
            <li>
              <span aria-hidden="true">04</span>
              <div>
                <h3>认同并遵守社区规范</h3>
                <p>包括社区道德、行为规范与服务器政策。</p>
              </div>
            </li>
          </ul>
          <p className={styles.finePrint}>
            以上条件由社区人工审核，出生日期与申请人类型不会自动决定审核结果。
          </p>
        </section>
        <section className={styles.section} aria-labelledby="join-process">
          <h2 id="join-process">从申请到加入。</h2>
          <ol className={styles.stages}>
            <li>
              <span aria-hidden="true">01</span>
              <h3>提交完整申请</h3>
              <p>了解条件，选择合适类别，填写完整资料。</p>
            </li>
            <li>
              <span aria-hidden="true">02</span>
              <h3>社区审核与安排</h3>
              <p>等待人工审核，线上面试及学院由社区组织。</p>
            </li>
            <li>
              <span aria-hidden="true">03</span>
              <h3>查看成员资格</h3>
              <p>获批后获得本账号的社区成员资格。</p>
            </li>
            <li>
              <span aria-hidden="true">04</span>
              <h3>跟进后续通知</h3>
              <p>登录后关注学院或社区的后续安排。</p>
            </li>
          </ol>
          <p className={styles.finePrint}>
            审核结果通过站内通知及本人结果页查询，当前关联要求与成员资格分别展示。
          </p>
        </section>
        <section
          className={`${styles.section} ${styles.faq}`}
          aria-labelledby="join-faq"
        >
          <h2 id="join-faq">你可能还想了解。</h2>
          <Accordion
            type="multiple"
            defaultValue={["faq-1"]}
            className={styles.accordion}
          >
            <AccordionItem value="faq-1">
              <AccordionTrigger>没有经验也可以申请吗？</AccordionTrigger>
              <AccordionContent>
                <p>
                  可以选择新玩家申请，按实际情况回答，后续指导由社区安排；已有相关经验的玩家选择调转申请。
                </p>
              </AccordionContent>
            </AccordionItem>
            <AccordionItem value="faq-2">
              <AccordionTrigger>何时安排面试、何时能有结果？</AccordionTrigger>
              <AccordionContent>
                <p>
                  以社区实际通知为准，不承诺固定时限。无法按时参加面试，请提前联系社区。等待期间可以阅读置顶指引、了解玩法和规则。
                </p>
              </AccordionContent>
            </AccordionItem>
            <AccordionItem value="faq-3">
              <AccordionTrigger>还未满足条件怎么办？</AccordionTrigger>
              <AccordionContent>
                <p>
                  请先了解条件并联系社区确认后续安排，资料与情况需要如实填写。
                </p>
              </AccordionContent>
            </AccordionItem>
            <AccordionItem value="faq-4">
              <AccordionTrigger>可以更换类别或再次申请吗？</AccordionTrigger>
              <AccordionContent>
                <p>
                  每个 Exre 账号对每个社区只能申请一次，待审核、通过和拒绝均不会释放机会。请通过本人结果页了解状态。
                </p>
              </AccordionContent>
            </AccordionItem>
            <AccordionItem value="faq-5">
              <AccordionTrigger>解除 Cfx 关联后需要重新申请吗？</AccordionTrigger>
              <AccordionContent>
                <p>
                  解除或更换 Cfx 关联不会删除原申请和成员资格，也不能重新申请；请在关联账户中重新满足社区当前要求。
                </p>
              </AccordionContent>
            </AccordionItem>
          </Accordion>
        </section>
        <section className={styles.contact} aria-labelledby="join-contact">
          <div>
            <h2 id="join-contact">保持联系。</h2>
            <p>
              请留意社区置顶指引与通知，通过社区工作人员了解面试和后续安排。
            </p>
          </div>
          {communityLinks.length > 0 && (
            <div className={styles.links}>
              {communityLinks.map((link) => (
                <Button key={link.label} asChild variant="outline">
                  <a href={link.url} target="_blank" rel="noopener noreferrer">
                    {link.label}
                  </a>
                </Button>
              ))}
            </div>
          )}
        </section>
      </div>
      {applicationType !== null && (
        <CompleteJoinApplicationModal
          key={applicationType}
          ref={form}
          open
          account={currentAccess?.account}
          submitDisabled={hasSubmitted || !!currentAccess?.status.application}
          applicationType={applicationType}
          resultTitle="申请已收到"
          initialDraft={drafts.current[applicationType]?.values}
          busy={busy}
          step={step}
          onStepChange={setStep}
          onOpenChange={(value) => {
            if (!value) close();
          }}
          onSubmit={submit}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            trigger.current?.focus();
          }}
          serverAction={<>
            {!token && <Button type="button" onClick={() => setAuthOpen(true)}>登录或注册后继续申请</Button>}
            {token && !currentAccess && <p role="status">正在确认当前账号与申请状态</p>}
            {accessError && <p role="alert">{accessError}</p>}
            {currentAccess && !currentAccess.status.requirementsMet && <Button type="button" onClick={() => setLinksOpen(true)}>关联 Cfx 后继续</Button>}
            {serverAction === 'query' && <Link to="/join/result">查询已有申请结果</Link>}
          </>}
        >
          {received ? (
            <section className={styles.applicationSuccess} aria-live="polite">
              <CircleCheck
                className={styles.successIcon}
                strokeWidth={1.5}
                aria-hidden="true"
              />
              <p className={styles.successLead}>资料提交成功</p>
              <p>
                申请资料已提交，请留意站内通知并在本人结果页查询。面试和学院安排由社区另行通知。
              </p>
              <Button asChild variant="outline">
                <Link to="/join/result">查询申请结果</Link>
              </Button>
              <Button disabled>面试预约</Button>
            </section>
          ) : undefined}
        </CompleteJoinApplicationModal>
      )}
      <Dialog open={authOpen} onOpenChange={setAuthOpen}><DialogContent><DialogHeader><DialogTitle>登录后继续申请</DialogTitle><DialogDescription>草稿仅保留在当前页面，登录成功后请确认提交。</DialogDescription></DialogHeader><CommunityAuthentication onSessionCreated={() => { setAuthOpen(false); setStatusReload(value => value + 1); }} /></DialogContent></Dialog>
      <Dialog open={linksOpen && token !== null} onOpenChange={value => { setLinksOpen(value); if (!value) setStatusReload(count => count + 1); }}><DialogContent><DialogHeader><DialogTitle>社区关联要求</DialogTitle><DialogDescription>关联完成后关闭此窗口，刷新资格并继续原申请。</DialogDescription></DialogHeader><IdentityLinksExperience token={token} /><Button onClick={() => { setLinksOpen(false); setStatusReload(value => value + 1); }}>返回申请并刷新资格</Button></DialogContent></Dialog>
    </main>
  );
}
