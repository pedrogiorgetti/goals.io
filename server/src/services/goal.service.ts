import dayjs from "dayjs";
import { db } from "db";
import { achievedGoals, goals } from "db/schema";
import { and, count, desc, eq, gte, lte, sql } from "drizzle-orm";
import type { Goal } from "entities/goal.entity";

type CreateGoalInput = {
  title: string;
  desiredWeeklyFrequency: number;
};

type CreateGoalOutput = {
  goal: Goal;
};

type IGoalList = Goal & {
  achievedCount: number;
};

type GetGoalsOutput = {
  list: IGoalList[];
};

type AchievedGoalsPerDay = Record<
  string,
  { id: string; title: string; achievedAt: string }[]
>;

type Summary = {
  achievedGoalsPerDay: AchievedGoalsPerDay;
  totalAchieved: number;
  total: number;
};

type GetWeekGoalsSummaryOutput = {
  summary: Summary;
};

export class GoalService {
  database = db;
  goalsTable = goals;
  achievedGoalsTable = achievedGoals;

  async create(input: CreateGoalInput): Promise<CreateGoalOutput> {
    const result = await this.database
      .insert(this.goalsTable)
      .values(input)
      .returning();

    const goal = result[0];
    return {
      goal,
    };
  }

  async getMany(): Promise<GetGoalsOutput> {
    const startOfWeek = dayjs().startOf("week").toDate();
    const endOfWeek = dayjs().endOf("week").toDate();

    const goalsCreatedUpToWeek = this.goalsCreatedUpToWeekSubQuery();

    const achievedGoalsCount = this.database.$with("achieved_goals_count").as(
      this.database
        .select({
          goalId: this.achievedGoalsTable.goalId,
          total: count(this.achievedGoalsTable.id).as("achievedCount"),
        })
        .from(this.achievedGoalsTable)
        .where(
          and(
            gte(this.achievedGoalsTable.createAt, startOfWeek),
            lte(this.achievedGoalsTable.createAt, endOfWeek)
          )
        )
        .groupBy(this.achievedGoalsTable.goalId)
    );

    const result = await this.database
      .with(goalsCreatedUpToWeek, achievedGoalsCount)
      .select({
        id: goalsCreatedUpToWeek.id,
        title: goalsCreatedUpToWeek.title,
        desiredWeeklyFrequency: goalsCreatedUpToWeek.desiredWeeklyFrequency,
        createAt: goalsCreatedUpToWeek.createAt,
        achievedCount: sql`COALESCE(${achievedGoalsCount.total}, 0)`
          .mapWith(Number)
          .as("achievedCount"),
      })
      .from(goalsCreatedUpToWeek)
      .leftJoin(
        achievedGoalsCount,
        eq(achievedGoalsCount.goalId, goalsCreatedUpToWeek.id)
      );

    return {
      list: result,
    };
  }

  async getWeekSummary(): Promise<GetWeekGoalsSummaryOutput> {
    const startOfWeek = dayjs().startOf("week").toDate();
    const endOfWeek = dayjs().endOf("week").toDate();

    const goalsCreatedUpToWeek = this.goalsCreatedUpToWeekSubQuery();

    const achievedGoalsInWeek = this.database.$with("achieved_goals_count").as(
      this.database
        .select({
          id: this.achievedGoalsTable.id,
          title: this.goalsTable.title,
          achievedAt: this.achievedGoalsTable.createAt,
          achievedAtDate: sql`DATE(${this.achievedGoalsTable.createAt})`.as(
            "achievedAtDate"
          ),
        })
        .from(achievedGoals)
        .innerJoin(
          this.goalsTable,
          eq(this.goalsTable.id, this.achievedGoalsTable.goalId)
        )
        .where(
          and(
            gte(this.achievedGoalsTable.createAt, startOfWeek),
            lte(this.achievedGoalsTable.createAt, endOfWeek)
          )
        )
        .orderBy(desc(this.achievedGoalsTable.createAt))
    );

    const achievedGoalsByWeekDay = this.database
      .$with("achieved_goals_by_day")
      .as(
        this.database
          .select({
            achievedAtDate: achievedGoalsInWeek.achievedAtDate,
            list: sql`
              JSON_AGG(
                JSON_BUILD_OBJECT(
                  'id', ${achievedGoalsInWeek.id},
                  'title', ${achievedGoalsInWeek.title},
                  'achievedAt', ${achievedGoalsInWeek.achievedAt}
                )
              )
            `.as("list"),
          })
          .from(achievedGoalsInWeek)
          .groupBy(achievedGoalsInWeek.achievedAtDate)
          .orderBy(desc(achievedGoalsInWeek.achievedAtDate))
      );

    const result = await this.database
      .with(goalsCreatedUpToWeek, achievedGoalsInWeek, achievedGoalsByWeekDay)
      .select({
        totalAchieved: sql`(SELECT COUNT(*) FROM ${achievedGoalsInWeek})`
          .mapWith(Number)
          .as("totalAchieved"),
        total:
          sql`(SELECT SUM(${goalsCreatedUpToWeek.desiredWeeklyFrequency}) FROM ${goalsCreatedUpToWeek})`
            .mapWith(Number)
            .as("total"),
        achievedGoalsPerDay: sql<AchievedGoalsPerDay>`JSON_OBJECT_AGG(
          ${achievedGoalsByWeekDay.achievedAtDate},
          ${achievedGoalsByWeekDay.list}
        )`.as("achievedGoalsPerDay"),
      })
      .from(achievedGoalsByWeekDay);

    return {
      summary: result[0],
    };
  }

  private goalsCreatedUpToWeekSubQuery() {
    const endOfWeek = dayjs().endOf("week").toDate();

    const query = this.database.$with("goals_created_up_to_week").as(
      this.database
        .select({
          id: this.goalsTable.id,
          title: this.goalsTable.title,
          desiredWeeklyFrequency: this.goalsTable.desiredWeeklyFrequency,
          createAt: this.goalsTable.createAt,
        })
        .from(this.goalsTable)
        .where(lte(this.goalsTable.createAt, endOfWeek))
    );

    return query;
  }
}
