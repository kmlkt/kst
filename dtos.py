from typing import Literal
import pydantic


class Parameter_Dto(pydantic.BaseModel):  
    parameter: str
    value: str
    unit: str
    state: Literal['normal', 'warning', 'error']
    norm: str
    operator: str


class Device_Dto(pydantic.BaseModel):
    tag: str
    name: str
    parameters: list[Parameter_Dto]


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