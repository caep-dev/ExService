import { forwardRef, useEffect, useId, useImperativeHandle, useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import {
  Alert,
  AlertDescription,
  Button,
  Field,
  FieldContent,
  FieldError,
  FieldGroup,
  FieldLabel,
  Input,
  Separator,
  Spinner,
} from "@exre/exui";
import { EyeIcon, EyeOffIcon } from "lucide-react";
import type { AuthFormHandle, AuthFormProps, LoginDraft } from "@components/src/auth/AuthForm";
import { ExIcon } from "@components/src/ExIcon";
import styles from "@components/src/auth/AuthForm.module.scss";

const loginSchema = z.object({
  email: z
    .string()
    .refine(
      (value) =>
        /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim()) &&
        Array.from(value.trim()).length <= 254,
      "请输入有效的邮箱地址",
    ),
  password: z
    .string()
    .refine(
      (value) =>
        Array.from(value).length >= 8 && Array.from(value).length <= 64,
      "密码必须为 8 至 64 个字符",
    ),
});

export const LoginForm = forwardRef<AuthFormHandle, AuthFormProps>(function LoginForm({
  initialEmail = "",
  description,
  busy,
  onContinueLogin,
  onJoin,
}: AuthFormProps, ref) {
  const id = useId();
  const [visible, setVisible] = useState(false);
  const {
    register,
    handleSubmit,
    getFieldState,
    setValue,
    setError,
    clearErrors,
    formState: { errors, isSubmitting },
  } = useForm<LoginDraft>({
    resolver: zodResolver(loginSchema),
    defaultValues: { email: initialEmail, password: "" },
  });
  const disabled = busy || isSubmitting;
  useImperativeHandle(ref, () => ({
    setServerErrors(nextErrors) {
      for (const field of ["email", "password"] as const) {
        if (nextErrors[field]) setError(field, { type: "server", message: nextErrors[field] });
      }
      if (nextErrors.form) setError("root.server", { type: "server", message: nextErrors.form });
    },
    clearServerErrors() {
      for (const field of ["email", "password"] as const) {
        if (getFieldState(field).error?.type === "server") clearErrors(field);
      }
      clearErrors("root.server");
    },
  }), [setError, clearErrors, getFieldState]);

  useEffect(() => {
    setValue("email", initialEmail);
  }, [initialEmail, setValue]);
  return (
    <form
      className={`${styles.form} ${styles.loginForm}`}
      noValidate
      aria-busy={disabled}
      onSubmit={handleSubmit((draft) => {
        if (!busy) onContinueLogin(draft);
      })}
    >
      <div className={`${styles.intro} ${styles.loginIntro}`}>
        <ExIcon size="6rem" className={styles.authIcon} />
        <h2 tabIndex={-1}>登录到 Exre</h2>
        {description && <p className={styles.destination}>{description}</p>}
        <p>
          还没有账号？{" "}
          <Button
            type="button"
            variant="link"
            disabled={disabled}
            onClick={onJoin}
          >
            注册账号
          </Button>
        </p>
      </div>
      {errors.root?.server && (
        <Alert variant="destructive" role="alert">
          <AlertDescription>{errors.root.server.message}</AlertDescription>
        </Alert>
      )}
      <FieldGroup>
        <Field data-invalid={errors.email ? true : undefined}>
          <FieldContent>
            <FieldLabel htmlFor={`${id}-email`}>邮箱</FieldLabel>
            <Input
              {...register("email")}
              id={`${id}-email`}
              type="email"
              autoComplete="email"
              autoFocus
              disabled={disabled}
              aria-invalid={errors.email ? true : undefined}
              aria-describedby={errors.email ? `${id}-email-error` : undefined}
            />
            {errors.email && (
              <FieldError id={`${id}-email-error`}>
                {errors.email.message}
              </FieldError>
            )}
          </FieldContent>
        </Field>
        <Field data-invalid={errors.password ? true : undefined}>
          <FieldContent>
            <FieldLabel htmlFor={`${id}-password`}>密码</FieldLabel>
            <div className={styles.loginPassword}>
              <Input
                {...register("password")}
                id={`${id}-password`}
                type={visible ? "text" : "password"}
                autoComplete="current-password"
                disabled={disabled}
                aria-invalid={errors.password ? true : undefined}
                aria-describedby={
                  errors.password ? `${id}-password-error` : undefined
                }
              />
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                className={styles.passwordToggle}
                disabled={disabled}
                aria-label={visible ? "隐藏密码" : "显示密码"}
                onClick={() => setVisible(!visible)}
              >
                {visible ? (
                  <EyeOffIcon aria-hidden="true" />
                ) : (
                  <EyeIcon aria-hidden="true" />
                )}
              </Button>
            </div>
            {errors.password && (
              <FieldError id={`${id}-password-error`}>
                {errors.password.message}
              </FieldError>
            )}
          </FieldContent>
        </Field>
      </FieldGroup>
      <Button type="submit" disabled={disabled} className={styles.submit}>
        {disabled ? (
          <>
            <Spinner aria-hidden="true" />
            处理中
          </>
        ) : (
          "继续"
        )}
      </Button>
      <div className={styles.loginSeparator}>
        <Separator />
        <span>或者</span>
        <Separator />
      </div>

      <div className={styles.providers}>
        <div className={styles.providerButtons}>
          <Button
            type="button"
            variant="outline"
            disabled
            aria-describedby={`${id}-providers`}
          >
            Google 暂未开放
          </Button>
          <Button
            type="button"
            variant="outline"
            disabled
            aria-describedby={`${id}-providers`}
          >
            QQ 暂未开放
          </Button>
        </div>
        <p id={`${id}-providers`} className={styles.providerHint}>
          Google、QQ 暂未开放
        </p>
      </div>
    </form>
  );
});
