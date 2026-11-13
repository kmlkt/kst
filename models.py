import pydantic
from tortoise.models import Model
from tortoise import fields
from tortoise.contrib.pydantic import pydantic_model_creator


class Device(Model):
    id = fields.IntField(primary_key=True)
    model = fields.TextField()
    



Device_Dto = pydantic_model_creator(Device, name="Device")


class Point_Dto(pydantic.BaseModel):
    x: int
    y: int


class Warning_Dto(pydantic.BaseModel):
    label: str
    points: list[Point_Dto]


class Error_Dto(pydantic.BaseModel):
    code: str
    label: str
    advice: str
    points: list[Point_Dto]


class Analysis_Dto(pydantic.BaseModel):
    device_points: list[Point_Dto]
    warnings: list[Warning_Dto]
    errors: list[Error_Dto]


class Property_Dto(pydantic.BaseModel):
    id: str
