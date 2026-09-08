import {it,expect} from 'vitest';
import {researchedVacationProration,VACATION_PRORATION_SPEC} from './release-vacation-proration';
const input={calendarYear:2026,annualGrossDays:16,employmentRelation:'whole_year',actualWorkdays:200,completeYearEvidence:true,section3Applicable:true};
it.each([
 ['whole_year',0,0],['whole_year',12,0],['whole_year',13,1],['whole_year',144,11],['whole_year',199,15],['whole_year',200,16],['whole_year',240,16],
 ['part_year',0,0],['part_year',199,13],['part_year',200,13],['part_year',239,15],['part_year',240,16],['part_year',300,16],
])('uses statutory %s threshold for %s actual days and floors once to %s gross days',(employmentRelation,actualWorkdays,expected)=>{
 const result=researchedVacationProration({...input,employmentRelation,actualWorkdays});expect(result.state).toBe('research_candidate');
 if(result.state==='research_candidate'){expect(result.execution.output).toEqual({kind:'integer',value:expected,unit:'calendar_days'});expect(result.activation_allowed).toBe(false);expect(result.human_attestation).toBeNull();}
});
it.each([
 {actualWorkdays:-1},{actualWorkdays:1.5},{actualWorkdays:367},{actualWorkdays:366},{actualWorkdays:null},
 {completeYearEvidence:false},{section3Applicable:false},{section3Applicable:null},{employmentRelation:'unknown'},
 {calendarYear:2016},{calendarYear:2027},{annualGrossDays:14},{annualGrossDays:29},{monthlyDays:20},
])('refuses unsupported or incomplete annual basis %j',change=>{expect(researchedVacationProration({...input,...change}).state).toBe('refused');});
it('retains exact fractional trace before the one annual rounding operation',()=>{
 const result=researchedVacationProration({...input,actualWorkdays:199});if(result.state!=='research_candidate')throw new Error('EXPECTED_RESEARCH_RESULT');
 expect(result.execution.trace.find(t=>t.step_id==='fractional.days')?.result).toEqual({kind:'rational',numerator:'398',denominator:'25',unit:'calendar_days'});
 expect(result.execution.trace.at(-1)?.operation).toBe('rational.floor');
 expect(researchedVacationProration({...input,actualWorkdays:199})).toEqual(result);
 expect(VACATION_PRORATION_SPEC.catalog_boundary).toBe('real_inactive');
});
it('accepts a leap-year bound and does not change seniority entitlement',()=>{
 const result=researchedVacationProration({...input,calendarYear:2024,actualWorkdays:366,annualGrossDays:28});
 expect(result.state==='research_candidate'&&result.execution.output).toEqual({kind:'integer',value:28,unit:'calendar_days'});
});
