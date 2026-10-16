import type { ReactNode } from 'react'
import { Alert, AlertDescription, Button, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, Tabs, TabsContent, TabsList, TabsTrigger } from '@exre/exui'
import styles from '@components/src/join/JoinReviewDialog.module.scss'

interface Props {
  open: boolean
  tab: 'application' | 'review'
  onTabChange: (tab: 'application' | 'review') => void
  onClose: () => void
  onCloseAutoFocus: (event: Event) => void
  loading: boolean
  error: string | null
  application: ReactNode
  review: ReactNode
  actions: ReactNode
  onRetry: () => void
}
export function JoinReviewDialog({ open, tab, onTabChange, onClose, onCloseAutoFocus, loading, error, application, review, actions, onRetry }: Props) {
  return <Dialog open={open} onOpenChange={value => { if (!value) onClose() }}>
    <DialogContent className={styles.content} onCloseAutoFocus={onCloseAutoFocus}>
      <DialogHeader><DialogTitle>申请详情</DialogTitle><DialogDescription>查看申请资料、审核事实和只读历史。</DialogDescription></DialogHeader>
      <Tabs className={styles.tabs} value={tab} onValueChange={value => { if (value === 'application' || value === 'review') onTabChange(value) }}>
        <TabsList className={styles.tabList}><TabsTrigger value="application">申请资料</TabsTrigger><TabsTrigger value="review">审核记录</TabsTrigger></TabsList>
        <div className={styles.scroll} aria-busy={loading}>
          {loading && <p role="status">正在加载申请详情</p>}
          {error && <Alert variant="destructive" role="alert"><AlertDescription>{error}</AlertDescription><Button variant="outline" onClick={onRetry} disabled={loading}>刷新详情</Button></Alert>}
          <TabsContent value="application">{application}</TabsContent><TabsContent value="review">{review}</TabsContent>
        </div>
      </Tabs>
      <DialogFooter className={styles.footer}>{actions}<Button variant="outline" onClick={onClose}>关闭详情</Button></DialogFooter>
    </DialogContent>
  </Dialog>
}
