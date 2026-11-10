import {
  ElectionScopeLevel,
  Prisma,
  type RegistryRecord,
} from '@prisma/client';

type ScopedElection = {
  scopeLevel: ElectionScopeLevel;
  scopeValue: string | null;
  closesOn: Date;
};

// Registry filter for the students who may vote in an election.
export function electorateWhere(
  election: ScopedElection,
  academicYearLabel: string,
): Prisma.RegistryRecordWhereInput {
  return {
    enrolment: 'ACTIVE',
    OR: [
      { registeredAcademicYear: academicYearLabel },
      { registeredAcademicYear: null },
    ],
    AND: [
      { OR: [{ studyEnd: null }, { studyEnd: { gte: election.closesOn } }] },
      scopeWhere(election),
    ],
  };
}

export function scopeWhere(
  election: Pick<ScopedElection, 'scopeLevel' | 'scopeValue'>,
): Prisma.RegistryRecordWhereInput {
  const value = election.scopeValue ?? '';
  switch (election.scopeLevel) {
    case ElectionScopeLevel.UNIVERSITY:
      return {};
    case ElectionScopeLevel.COLLEGE:
      return { OR: [{ collegeCode: value }, { college: value }] };
    case ElectionScopeLevel.SCHOOL:
      return { school: value };
    case ElectionScopeLevel.DEPARTMENT:
      return { department: value };
    default:
      return { campus: value };
  }
}

export function inScope(
  student: Pick<
    RegistryRecord,
    'collegeCode' | 'college' | 'school' | 'department' | 'campus'
  >,
  election: Pick<ScopedElection, 'scopeLevel' | 'scopeValue'>,
) {
  const value = election.scopeValue;
  switch (election.scopeLevel) {
    case ElectionScopeLevel.UNIVERSITY:
      return true;
    case ElectionScopeLevel.COLLEGE:
      return student.collegeCode === value || student.college === value;
    case ElectionScopeLevel.SCHOOL:
      return student.school === value;
    case ElectionScopeLevel.DEPARTMENT:
      return student.department === value;
    default:
      return student.campus === value;
  }
}

// Whether the registry lists the student as a current student until the given date.
export function registryStanding(
  student: Pick<
    RegistryRecord,
    'enrolment' | 'registeredAcademicYear' | 'studyEnd'
  >,
  academicYearLabel: string,
  until: Date,
) {
  const reasons: string[] = [];
  if (student.enrolment !== 'ACTIVE')
    reasons.push(`Registry status is ${student.enrolment.toLowerCase()}.`);
  if (
    student.registeredAcademicYear &&
    student.registeredAcademicYear !== academicYearLabel
  )
    reasons.push(`Not registered for ${academicYearLabel}.`);
  if (student.studyEnd && student.studyEnd < until)
    reasons.push('Study period ends before this date.');
  return { ok: reasons.length === 0, reasons };
}
