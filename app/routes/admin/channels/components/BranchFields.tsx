import { useState } from "react";

import type { BranchFormOptions } from "~/server/services/admin/channels/branches.server";
import { Select, TextField } from "~/ui/Field";
import { useChT } from "./ui";

export type BranchValues = {
  code: string;
  nameAr: string;
  nameEn: string;
  governorateId: string;
  districtId: string;
  addressText: string;
  phone: string;
  hoursAr: string;
  hoursEn: string;
};

export const EMPTY_BRANCH: BranchValues = { code: "", nameAr: "", nameEn: "", governorateId: "", districtId: "", addressText: "", phone: "", hoursAr: "", hoursEn: "" };

/**
 * The fields of a branch (create and edit). The district list follows the governorate chosen; without JavaScript the
 * server still refuses a district of another governorate (district_mismatch).
 */
export function BranchFields({ values, options, errors }: { values: BranchValues; options: BranchFormOptions; errors: Record<string, string> }) {
  const t = useChT();
  const [governorate, setGovernorate] = useState(values.governorateId);
  const districts = options.districts.filter((district) => district.governorateId === governorate);
  return (
    <div className="ch-form ch-form--two">
      <TextField name="code" label={t("branch.field.code")} hint={t("branch.field.codeHint")} required ltr maxLength={16} autoCapitalize="characters" defaultValue={values.code} error={errors.code} />
      <TextField name="phone" type="tel" label={t("branch.field.phone")} hint={t("branch.field.phoneHint")} optional maxLength={40} defaultValue={values.phone} error={errors.phone} />
      <TextField name="nameAr" label={t("branch.field.nameAr")} required maxLength={80} defaultValue={values.nameAr} error={errors.nameAr} />
      <TextField name="nameEn" label={t("branch.field.nameEn")} optional maxLength={80} ltr lang="en" defaultValue={values.nameEn} error={errors.nameEn} />
      <Select
        name="governorateId"
        label={t("branch.field.governorate")}
        optional
        value={governorate}
        onChange={(event) => setGovernorate(event.target.value)}
        options={[{ value: "", label: t("branch.field.none") }, ...options.governorates.map((option) => ({ value: option.id, label: option.name }))]}
        error={errors.governorateId}
      />
      <Select
        key={governorate}
        name="districtId"
        label={t("branch.field.district")}
        optional
        hint={governorate ? undefined : t("branch.field.districtHint")}
        defaultValue={districts.some((district) => district.id === values.districtId) ? values.districtId : ""}
        options={[{ value: "", label: t("branch.field.none") }, ...districts.map((option) => ({ value: option.id, label: option.name }))]}
        error={errors.districtId}
      />
      <TextField className="ch-span" name="addressText" label={t("branch.field.address")} optional maxLength={300} defaultValue={values.addressText} error={errors.addressText} />
      <TextField name="hoursAr" label={t("branch.field.hoursAr")} hint={t("branch.field.hoursHint")} optional maxLength={200} defaultValue={values.hoursAr} error={errors.hoursAr} />
      <TextField name="hoursEn" label={t("branch.field.hoursEn")} optional maxLength={200} ltr lang="en" defaultValue={values.hoursEn} error={errors.hoursEn} />
    </div>
  );
}

export function branchValuesFrom(form: FormData): BranchValues {
  const value = (name: string) => {
    const raw = form.get(name);
    return typeof raw === "string" ? raw : "";
  };
  return {
    code: value("code"),
    nameAr: value("nameAr"),
    nameEn: value("nameEn"),
    governorateId: value("governorateId"),
    districtId: value("districtId"),
    addressText: value("addressText"),
    phone: value("phone"),
    hoursAr: value("hoursAr"),
    hoursEn: value("hoursEn"),
  };
}
